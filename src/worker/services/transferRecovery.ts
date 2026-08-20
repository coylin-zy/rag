import type { Env, TransferQueueMessage } from "@worker/env";

import { nowIso } from "../lib/utils";

const STALE_TRANSFER_MS = 10 * 60 * 1000;
const MAX_TRANSFER_ATTEMPTS = 10;

async function recomputeJob(env: Env, jobId: string) {
  const counts = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) AS active
    FROM transfer_items WHERE job_id = ?
  `).bind(jobId).first<{ completed: number; failed: number; active: number }>();
  const active = Number(counts?.active ?? 0);
  const now = nowIso();
  await env.DB.prepare(`
    UPDATE transfer_jobs
    SET status = ?, completed_items = ?, failed_items = ?, updated_at = ?,
        completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END
    WHERE id = ? AND kind = 'import' AND status != 'cancelled'
  `).bind(
    active ? "processing" : "completed",
    Number(counts?.completed ?? 0),
    Number(counts?.failed ?? 0),
    now,
    active ? "processing" : "completed",
    now,
    jobId,
  ).run();
}

export async function recoverStaleTransfers(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_TRANSFER_MS).toISOString();
  const rows = await env.DB.prepare(`
    SELECT i.id AS itemId, i.job_id AS jobId, i.attempts, j.plan_version AS planVersion,
           i.status, i.error_code AS errorCode
    FROM transfer_items i
    JOIN transfer_jobs j ON j.id = i.job_id AND j.kind = 'import'
    WHERE (
      (i.status IN ('queued', 'processing') AND i.updated_at < ?)
      OR (i.status = 'failed' AND i.error_code = 'transfer_queue_send_failed')
    )
      AND j.status != 'cancelled'
    ORDER BY i.updated_at ASC
    LIMIT 100
  `).bind(cutoff).all<{
    itemId: string;
    jobId: string;
    attempts: number;
    planVersion: number;
    status: string;
    errorCode: string | null;
  }>();

  const touchedJobs = new Set<string>();
  for (const row of rows.results ?? []) {
    touchedJobs.add(row.jobId);
    if (row.attempts >= MAX_TRANSFER_ATTEMPTS) {
      const now = nowIso();
      await env.DB.prepare(`
        UPDATE transfer_items
        SET status = 'failed', error_code = 'transfer_retry_exhausted',
            error_message = 'Transfer recovery 重试次数已耗尽', updated_at = ?, completed_at = ?
        WHERE id = ? AND job_id = ? AND status != 'completed'
      `).bind(now, now, row.itemId, row.jobId).run();
      continue;
    }

    const now = nowIso();
    await env.DB.prepare(`
      UPDATE transfer_items
      SET status = 'queued', error_code = NULL, error_message = NULL, updated_at = ?, completed_at = NULL
      WHERE id = ? AND job_id = ? AND status != 'completed'
    `).bind(now, row.itemId, row.jobId).run();
    await env.DB.prepare(`
      UPDATE transfer_jobs SET status = 'queued', completed_at = NULL, updated_at = ?
      WHERE id = ? AND status != 'cancelled'
    `).bind(now, row.jobId).run();

    const message: TransferQueueMessage = {
      type: "import_apply",
      jobId: row.jobId,
      itemId: row.itemId,
      planVersion: row.planVersion,
    };
    try {
      await env.TRANSFER_QUEUE.send(message);
    } catch {
      // Leave the item queued. A later cron run can try the producer again.
    }
  }

  for (const jobId of touchedJobs) await recomputeJob(env, jobId);
}
