import type { Env, TransferQueueMessage } from "@worker/env";

import { nowIso } from "../lib/utils";
import { processImportApplyMessage } from "./importApply";

const MAX_TRANSFER_ATTEMPTS = 10;

async function recordAttempt(env: Env, message: TransferQueueMessage): Promise<number> {
  await env.DB.prepare(`
    UPDATE transfer_items
    SET attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND job_id = ? AND status IN ('queued', 'processing')
  `).bind(nowIso(), message.itemId, message.jobId).run();
  const row = await env.DB.prepare("SELECT attempts FROM transfer_items WHERE id = ? AND job_id = ? LIMIT 1")
    .bind(message.itemId, message.jobId)
    .first<{ attempts: number }>();
  return Number(row?.attempts ?? 0);
}

async function exhaustItem(env: Env, message: TransferQueueMessage) {
  const now = nowIso();
  await env.DB.prepare(`
    UPDATE transfer_items
    SET status = 'failed', error_code = 'transfer_retry_exhausted',
        error_message = 'Transfer Queue 重试次数已耗尽', updated_at = ?, completed_at = ?
    WHERE id = ? AND job_id = ? AND status IN ('queued', 'processing')
  `).bind(now, now, message.itemId, message.jobId).run();
  const active = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM transfer_items
    WHERE job_id = ? AND status IN ('queued', 'processing')
  `).bind(message.jobId).first<{ count: number }>();
  if (Number(active?.count ?? 0) === 0) {
    await env.DB.prepare(`
      UPDATE transfer_jobs
      SET status = 'completed',
          completed_items = (SELECT COUNT(*) FROM transfer_items WHERE job_id = ? AND status = 'completed'),
          failed_items = (SELECT COUNT(*) FROM transfer_items WHERE job_id = ? AND status = 'failed'),
          updated_at = ?, completed_at = ?
      WHERE id = ? AND status != 'cancelled'
    `).bind(message.jobId, message.jobId, now, now, message.jobId).run();
  }
}

export async function handleTransferQueue(batch: MessageBatch<TransferQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const attempts = await recordAttempt(env, message.body);
      if (attempts > MAX_TRANSFER_ATTEMPTS) {
        await exhaustItem(env, message.body);
        message.ack();
        continue;
      }
      await processImportApplyMessage(env, message.body);
      message.ack();
    } catch {
      message.retry();
    }
  }
}
