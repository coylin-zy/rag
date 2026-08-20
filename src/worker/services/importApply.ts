import type { AdminPrincipal, Env, TransferQueueMessage } from "@worker/env";

import { requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError, safeErrorSummary } from "../lib/errors";
import { nowIso } from "../lib/utils";
import { getImportJob } from "./importJobs";
import { createImportedNote, updateImportedNote } from "./importWrites";
import { normalizeImportPath, validateImportMarkdown } from "./transferValidation";

export interface ImportDecision {
  itemId: string;
  decision: "skip" | "overwrite" | "copy";
  copyPath?: string | null;
}

interface JobRow {
  id: string;
  collectionId: string;
  status: string;
  planVersion: number;
  createdBy: string;
  startedAt: string | null;
}

interface ItemRow {
  id: string;
  jobId: string;
  relativePath: string;
  stagedR2Key: string | null;
  sourceSha256: string | null;
  action: "create" | "update" | "unchanged" | "conflict" | "conflict_deleted" | "invalid" | null;
  decision: "skip" | "overwrite" | "copy" | null;
  decisionPath: string | null;
  status: string;
  targetNoteId: string | null;
  expectedVersion: number | null;
  resultNoteId: string | null;
  resultVersion: number | null;
}

async function getJob(env: Env, jobId: string) {
  return env.DB.prepare(`
    SELECT id, collection_id AS collectionId, status, plan_version AS planVersion,
           created_by AS createdBy, started_at AS startedAt
    FROM transfer_jobs WHERE id = ? AND kind = 'import' LIMIT 1
  `).bind(jobId).first<JobRow>();
}

async function getItem(env: Env, jobId: string, itemId: string) {
  return env.DB.prepare(`
    SELECT id, job_id AS jobId, relative_path AS relativePath, staged_r2_key AS stagedR2Key,
           source_sha256 AS sourceSha256, action, decision, decision_path AS decisionPath,
           status, target_note_id AS targetNoteId, expected_version AS expectedVersion,
           result_note_id AS resultNoteId, result_version AS resultVersion
    FROM transfer_items WHERE id = ? AND job_id = ? LIMIT 1
  `).bind(itemId, jobId).first<ItemRow>();
}

async function refreshJobProgress(env: Env, jobId: string) {
  const now = nowIso();
  const counts = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) AS active
    FROM transfer_items WHERE job_id = ?
  `).bind(jobId).first<{ total: number; completed: number; failed: number; active: number }>();
  const active = Number(counts?.active ?? 0);
  const status = active > 0 ? "processing" : "completed";
  await env.DB.prepare(`
    UPDATE transfer_jobs
    SET status = ?, completed_items = ?, failed_items = ?, updated_at = ?,
        completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
    WHERE id = ? AND kind = 'import' AND status != 'cancelled'
  `).bind(
    status,
    Number(counts?.completed ?? 0),
    Number(counts?.failed ?? 0),
    now,
    status,
    now,
    jobId,
  ).run();
}

export async function applyImportJob(
  env: Env,
  principal: AdminPrincipal,
  jobId: string,
  input: { planVersion: number; decisions?: ImportDecision[] },
) {
  const job = await getJob(env, jobId);
  if (!job) throw new ApiError(404, "import_job_not_found", "导入任务不存在或无权访问");
  await requireCollectionRole(env, principal, job.collectionId, "editor");
  if (job.planVersion !== input.planVersion) {
    throw new ApiError(409, "import_plan_stale", "导入计划版本已变化，请重新查看 dry-run");
  }
  if (job.status === "queued" || job.status === "processing" || job.status === "completed") {
    return getImportJob(env, principal, jobId);
  }
  if (job.status !== "planned") throw new ApiError(409, "import_apply_conflict", "导入任务当前状态不能执行");

  const decisionMap = new Map((input.decisions ?? []).map((decision) => [decision.itemId, decision]));
  const rows = await env.DB.prepare(`
    SELECT id, relative_path AS relativePath, action, target_note_id AS targetNoteId,
           expected_version AS expectedVersion
    FROM transfer_items WHERE job_id = ? ORDER BY relative_path
  `).bind(jobId).all<{
    id: string;
    relativePath: string;
    action: ItemRow["action"];
    targetNoteId: string | null;
    expectedVersion: number | null;
  }>();

  const queuedMessages: TransferQueueMessage[] = [];
  const now = nowIso();
  for (const item of rows.results ?? []) {
    const explicit = decisionMap.get(item.id);
    let decision: "skip" | "overwrite" | "copy" | null = null;
    let decisionPath: string | null = null;
    let status: "queued" | "completed" | "failed";

    if (item.action === "invalid") {
      status = "failed";
    } else if (item.action === "unchanged") {
      status = "completed";
      if (item.targetNoteId) {
        await env.DB.prepare("UPDATE notes SET sync_base_hash = content_hash WHERE id = ? AND collection_id = ?")
          .bind(item.targetNoteId, job.collectionId).run();
      }
    } else if (item.action === "create" || item.action === "update") {
      status = "queued";
    } else {
      decision = explicit?.decision ?? "skip";
      if (decision === "skip") {
        status = "completed";
      } else if (decision === "overwrite") {
        if (item.action === "conflict_deleted") {
          throw new ApiError(409, "deleted_import_overwrite_forbidden", "回收站文档不能被导入任务直接覆盖，请恢复后重新规划或选择复制");
        }
        if (!item.targetNoteId || !item.expectedVersion) {
          throw new ApiError(409, "import_plan_invalid", "覆盖决策缺少目标版本信息");
        }
        status = "queued";
      } else {
        if (!explicit?.copyPath) throw new ApiError(422, "import_copy_path_required", "复制冲突文件时必须指定新的 .md 相对路径");
        decisionPath = normalizeImportPath(explicit.copyPath);
        if (decisionPath === item.relativePath) throw new ApiError(422, "import_copy_path_same", "复制路径必须与原导入路径不同");
        const occupied = await env.DB.prepare("SELECT id FROM notes WHERE collection_id = ? AND external_path = ? LIMIT 1")
          .bind(job.collectionId, decisionPath).first<{ id: string }>();
        if (occupied) throw new ApiError(409, "import_copy_path_conflict", "复制目标路径已被现有文档占用");
        status = "queued";
      }
    }

    const operationKey = `${jobId}:${item.id}:${job.planVersion}`;
    await env.DB.prepare(`
      UPDATE transfer_items
      SET decision = ?, decision_path = ?, status = ?, operation_key = ?, updated_at = ?,
          completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE NULL END
      WHERE id = ? AND job_id = ? AND status = 'planned'
    `).bind(
      decision,
      decisionPath,
      status,
      operationKey,
      now,
      status,
      now,
      item.id,
      jobId,
    ).run();

    if (status === "queued") {
      queuedMessages.push({ type: "import_apply", jobId, itemId: item.id, planVersion: job.planVersion });
    }
  }

  await env.DB.prepare(`
    UPDATE transfer_jobs
    SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE id = ? AND status = 'planned' AND plan_version = ?
  `).bind(queuedMessages.length ? "queued" : "completed", now, now, jobId, job.planVersion).run();

  for (const message of queuedMessages) {
    try {
      await env.TRANSFER_QUEUE.send(message);
    } catch (error) {
      await env.DB.prepare(`
        UPDATE transfer_items
        SET status = 'failed', error_code = 'transfer_queue_send_failed', error_message = ?,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND job_id = ? AND status = 'queued'
      `).bind(safeErrorSummary(error), nowIso(), nowIso(), message.itemId, jobId).run();
    }
  }

  await refreshJobProgress(env, jobId);
  await writeAudit(env, {
    actorType: "user",
    actorId: principal.email,
    action: "import.apply",
    resourceType: "transfer_job",
    resourceId: jobId,
    collectionIds: [job.collectionId],
    metadata: { planVersion: job.planVersion, queuedItems: queuedMessages.length },
  });
  return getImportJob(env, principal, jobId);
}

async function markItemFailure(env: Env, jobId: string, itemId: string, error: unknown) {
  const apiError = error instanceof ApiError ? error : null;
  await env.DB.prepare(`
    UPDATE transfer_items
    SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?, completed_at = ?
    WHERE id = ? AND job_id = ? AND status IN ('queued', 'processing')
  `).bind(
    apiError?.code ?? "import_apply_failed",
    apiError?.message ?? safeErrorSummary(error),
    nowIso(),
    nowIso(),
    itemId,
    jobId,
  ).run();
  await refreshJobProgress(env, jobId);
}

export async function processImportApplyMessage(env: Env, message: TransferQueueMessage) {
  const job = await getJob(env, message.jobId);
  const item = await getItem(env, message.jobId, message.itemId);
  if (!job || !item) return;
  if (item.status === "completed" || item.status === "failed" || item.status === "cancelled") return;
  if (job.status === "cancelled") {
    await env.DB.prepare(`
      UPDATE transfer_items SET status = 'cancelled', updated_at = ?, completed_at = ?
      WHERE id = ? AND job_id = ? AND status IN ('queued', 'processing')
    `).bind(nowIso(), nowIso(), item.id, job.id).run();
    return;
  }
  if (job.planVersion !== message.planVersion) {
    await markItemFailure(env, job.id, item.id, new ApiError(409, "import_plan_stale", "Queue 消息对应的导入计划已过期"));
    return;
  }

  const claimed = await env.DB.prepare(`
    UPDATE transfer_items SET status = 'processing', updated_at = ?
    WHERE id = ? AND job_id = ? AND status IN ('queued', 'processing')
  `).bind(nowIso(), item.id, job.id).run();
  if (Number(claimed.meta.changes) !== 1) return;
  await env.DB.prepare(`
    UPDATE transfer_jobs SET status = 'processing', started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE id = ? AND status IN ('queued', 'processing')
  `).bind(nowIso(), nowIso(), job.id).run();

  try {
    if (!item.stagedR2Key || !item.sourceSha256 || !item.action) {
      throw new ApiError(422, "import_stage_missing", "导入 Queue 项缺少暂存元数据");
    }
    const object = await env.NOTES.get(item.stagedR2Key);
    if (!object) throw new ApiError(503, "import_stage_missing", "导入暂存对象不存在");
    const markdown = await object.text();
    const actualHash = await sha256(markdown.replace(/\r\n/g, "\n"));
    if (actualHash !== item.sourceSha256) throw new ApiError(422, "import_stage_hash_mismatch", "导入暂存对象哈希已变化");
    await validateImportMarkdown({ relativePath: item.relativePath, markdown, clientSha256: item.sourceSha256 });

    const principal: AdminPrincipal = {
      email: job.createdBy,
      subject: `transfer:${job.id}`,
      bootstrapAdmin: false,
    };
    let result: { id: string; version: number };
    if (item.action === "create") {
      result = await createImportedNote(env, principal, job.collectionId, item.relativePath, markdown);
    } else if (item.action === "update" || (item.action === "conflict" && item.decision === "overwrite")) {
      if (!item.targetNoteId || !item.expectedVersion) throw new ApiError(409, "import_plan_invalid", "导入更新缺少目标版本");
      result = await updateImportedNote(env, principal, item.targetNoteId, item.expectedVersion, item.relativePath, markdown);
    } else if ((item.action === "conflict" || item.action === "conflict_deleted") && item.decision === "copy") {
      if (!item.decisionPath) throw new ApiError(422, "import_copy_path_required", "复制导入缺少目标路径");
      result = await createImportedNote(env, principal, job.collectionId, item.decisionPath, markdown);
    } else {
      await env.DB.prepare(`
        UPDATE transfer_items SET status = 'completed', updated_at = ?, completed_at = ?
        WHERE id = ? AND job_id = ?
      `).bind(nowIso(), nowIso(), item.id, job.id).run();
      await refreshJobProgress(env, job.id);
      return;
    }

    await env.DB.prepare(`
      UPDATE transfer_items
      SET status = 'completed', result_note_id = ?, result_version = ?,
          error_code = NULL, error_message = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND job_id = ? AND status = 'processing'
    `).bind(result.id, result.version, nowIso(), nowIso(), item.id, job.id).run();
    await refreshJobProgress(env, job.id);
  } catch (error) {
    if (error instanceof ApiError && error.status >= 500) throw error;
    await markItemFailure(env, job.id, item.id, error);
  }
}

export async function cancelImportJob(env: Env, principal: AdminPrincipal, jobId: string) {
  const job = await getJob(env, jobId);
  if (!job) throw new ApiError(404, "import_job_not_found", "导入任务不存在或无权访问");
  await requireCollectionRole(env, principal, job.collectionId, "editor");
  if (job.status === "completed" || job.status === "cancelled") return getImportJob(env, principal, jobId);
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE transfer_jobs SET status = 'cancelled', cancelled_at = ?, updated_at = ?
      WHERE id = ? AND kind = 'import' AND status != 'completed'
    `).bind(now, now, jobId),
    env.DB.prepare(`
      UPDATE transfer_items SET status = 'cancelled', updated_at = ?, completed_at = ?
      WHERE job_id = ? AND status IN ('uploaded', 'planned', 'queued')
    `).bind(now, now, jobId),
  ]);
  await writeAudit(env, {
    actorType: "user",
    actorId: principal.email,
    action: "import.cancel",
    resourceType: "transfer_job",
    resourceId: jobId,
    collectionIds: [job.collectionId],
    metadata: {},
  });
  return getImportJob(env, principal, jobId);
}
