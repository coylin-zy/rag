import type { AdminPrincipal, Env } from "@worker/env";

import { requireCollectionRole } from "../lib/auth";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { nowIso } from "../lib/utils";
import {
  MAX_IMPORT_ITEMS,
  MAX_IMPORT_TOTAL_BYTES,
  assertImportJobLimits,
  validateImportMarkdown,
} from "./transferValidation";

export type ImportAction = "create" | "update" | "unchanged" | "conflict" | "conflict_deleted" | "invalid";

interface ImportJobRow {
  id: string;
  collectionId: string;
  status: string;
  planVersion: number;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  conflictItems: number;
  invalidItems: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  lastError: string | null;
}

interface ImportItemRow {
  id: string;
  jobId: string;
  relativePath: string;
  stagedR2Key: string | null;
  sourceSha256: string | null;
  byteSize: number;
  action: ImportAction | null;
  decision: "skip" | "overwrite" | "copy" | null;
  decisionPath: string | null;
  status: string;
  attempts: number;
  targetNoteId: string | null;
  expectedVersion: number | null;
  resultNoteId: string | null;
  resultVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

function jobSelect() {
  return `
    SELECT id, collection_id AS collectionId, status, plan_version AS planVersion,
           total_items AS totalItems, completed_items AS completedItems,
           failed_items AS failedItems, conflict_items AS conflictItems,
           invalid_items AS invalidItems, total_bytes AS totalBytes,
           created_at AS createdAt, updated_at AS updatedAt, created_by AS createdBy,
           last_error AS lastError
    FROM transfer_jobs
  `;
}

function itemSelect() {
  return `
    SELECT id, job_id AS jobId, relative_path AS relativePath, staged_r2_key AS stagedR2Key,
           source_sha256 AS sourceSha256, byte_size AS byteSize, action, decision,
           decision_path AS decisionPath, status, attempts,
           target_note_id AS targetNoteId, expected_version AS expectedVersion,
           result_note_id AS resultNoteId, result_version AS resultVersion,
           error_code AS errorCode, error_message AS errorMessage,
           created_at AS createdAt, updated_at AS updatedAt
    FROM transfer_items
  `;
}

async function requireImportJob(env: Env, principal: AdminPrincipal, jobId: string, minimumRole: "viewer" | "editor" = "viewer") {
  const job = await env.DB.prepare(`${jobSelect()} WHERE id = ? AND kind = 'import' LIMIT 1`)
    .bind(jobId)
    .first<ImportJobRow>();
  if (!job) throw new ApiError(404, "import_job_not_found", "导入任务不存在或无权访问");
  await requireCollectionRole(env, principal, job.collectionId, minimumRole);
  return job;
}

export async function createImportJob(env: Env, principal: AdminPrincipal, collectionId: string) {
  await requireCollectionRole(env, principal, collectionId, "editor");
  const id = crypto.randomUUID();
  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO transfer_jobs (
      id, kind, collection_id, status, plan_version, total_items, completed_items,
      failed_items, conflict_items, invalid_items, total_bytes,
      created_at, updated_at, created_by
    ) VALUES (?, 'import', ?, 'draft', 0, 0, 0, 0, 0, 0, 0, ?, ?, ?)
  `).bind(id, collectionId, now, now, principal.email).run();

  return {
    id,
    collectionId,
    status: "draft" as const,
    planVersion: 0,
    limits: {
      maxItems: MAX_IMPORT_ITEMS,
      maxFileBytes: 2 * 1024 * 1024,
      maxTotalBytes: MAX_IMPORT_TOTAL_BYTES,
      maxPathBytes: 512,
    },
    createdAt: now,
  };
}

export async function uploadImportItem(
  env: Env,
  principal: AdminPrincipal,
  jobId: string,
  itemId: string,
  input: { relativePath: string; markdown: string; sha256?: string | null },
) {
  const job = await requireImportJob(env, principal, jobId, "editor");
  if (job.status !== "draft") throw new ApiError(409, "import_job_frozen", "导入任务已经进入规划阶段，不能继续上传文件");

  const validated = await validateImportMarkdown({
    relativePath: input.relativePath,
    markdown: input.markdown,
    clientSha256: input.sha256,
  });

  const existing = await env.DB.prepare(`${itemSelect()} WHERE job_id = ? AND relative_path = ? LIMIT 1`)
    .bind(jobId, validated.relativePath)
    .first<ImportItemRow>();
  if (existing) {
    if (existing.sourceSha256 === validated.sourceSha256 && existing.byteSize === validated.byteSize) return existing;
    throw new ApiError(409, "duplicate_import_path", "同一导入任务中不能上传两个不同内容的同路径文件");
  }

  const stagedR2Key = `imports/${jobId}/files/${itemId}.md`;
  await env.NOTES.put(stagedR2Key, input.markdown.replace(/\r\n/g, "\n"), {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: {
      jobId,
      itemId,
      relativePath: validated.relativePath,
      sha256: validated.sourceSha256,
    },
  });

  const now = nowIso();
  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO transfer_items (
        id, job_id, relative_path, staged_r2_key, source_sha256, byte_size,
        status, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 'uploaded', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM transfer_jobs j
        WHERE j.id = ? AND j.kind = 'import' AND j.status = 'draft'
      )
      AND (SELECT COUNT(*) FROM transfer_items WHERE job_id = ?) < ?
      AND (SELECT COALESCE(SUM(byte_size), 0) FROM transfer_items WHERE job_id = ?) + ? <= ?
    `).bind(
      itemId,
      jobId,
      validated.relativePath,
      stagedR2Key,
      validated.sourceSha256,
      validated.byteSize,
      now,
      now,
      jobId,
      jobId,
      MAX_IMPORT_ITEMS,
      jobId,
      validated.byteSize,
      MAX_IMPORT_TOTAL_BYTES,
    ).run();

    if (Number(inserted.meta.changes) !== 1) {
      const aggregate = await env.DB.prepare(`
        SELECT COUNT(*) AS itemCount, COALESCE(SUM(byte_size), 0) AS totalBytes
        FROM transfer_items WHERE job_id = ?
      `).bind(jobId).first<{ itemCount: number; totalBytes: number }>();
      assertImportJobLimits({
        itemCount: (aggregate?.itemCount ?? 0) + 1,
        totalBytes: (aggregate?.totalBytes ?? 0) + validated.byteSize,
      });
      throw new ApiError(409, "import_upload_conflict", "导入任务状态已变化或文件路径发生并发冲突");
    }

    await env.DB.prepare(`
      UPDATE transfer_jobs
      SET total_items = (SELECT COUNT(*) FROM transfer_items WHERE job_id = ?),
          total_bytes = (SELECT COALESCE(SUM(byte_size), 0) FROM transfer_items WHERE job_id = ?),
          updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).bind(jobId, jobId, now, jobId).run();
  } catch (error) {
    await env.NOTES.delete(stagedR2Key).catch(() => undefined);
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "import_upload_conflict", "导入文件保存冲突，请刷新任务后重试");
  }

  return env.DB.prepare(`${itemSelect()} WHERE id = ? AND job_id = ? LIMIT 1`)
    .bind(itemId, jobId)
    .first<ImportItemRow>();
}

async function classifyItem(env: Env, job: ImportJobRow, item: ImportItemRow) {
  try {
    if (!item.stagedR2Key || !item.sourceSha256) throw new ApiError(422, "import_stage_missing", "导入暂存元数据不完整");
    const object = await env.NOTES.get(item.stagedR2Key);
    if (!object) throw new ApiError(422, "import_stage_missing", "导入暂存文件不存在");
    const markdown = await object.text();
    const stagedHash = await sha256(markdown.replace(/\r\n/g, "\n"));
    if (stagedHash !== item.sourceSha256) throw new ApiError(422, "import_stage_hash_mismatch", "导入暂存文件哈希不一致");
    const validated = await validateImportMarkdown({
      relativePath: item.relativePath,
      markdown,
      clientSha256: item.sourceSha256,
    });

    type Target = {
      id: string;
      status: string;
      version: number;
      contentHash: string;
      syncBaseHash: string | null;
    };
    let target = await env.DB.prepare(`
      SELECT id, status, version, content_hash AS contentHash, sync_base_hash AS syncBaseHash
      FROM notes
      WHERE collection_id = ? AND external_path = ?
      LIMIT 1
    `).bind(job.collectionId, item.relativePath).first<Target>();

    const exportedId = validated.document.frontmatter.id;
    if (!target && exportedId && item.relativePath === `${exportedId}.md`) {
      target = await env.DB.prepare(`
        SELECT id, status, version, content_hash AS contentHash, sync_base_hash AS syncBaseHash
        FROM notes
        WHERE id = ? AND collection_id = ? AND external_path IS NULL
        LIMIT 1
      `).bind(exportedId, job.collectionId).first<Target>();
    }

    let action: ImportAction;
    if (!target) action = "create";
    else if (target.status === "deleted") action = "conflict_deleted";
    else if (target.contentHash === item.sourceSha256) action = "unchanged";
    else if (target.syncBaseHash && target.contentHash === target.syncBaseHash) action = "update";
    else action = "conflict";

    return {
      action,
      targetNoteId: target?.id ?? null,
      expectedVersion: target?.version ?? null,
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        action: "invalid" as const,
        targetNoteId: null,
        expectedVersion: null,
        errorCode: error.code,
        errorMessage: error.message,
      };
    }
    throw error;
  }
}

export async function planImportJob(env: Env, principal: AdminPrincipal, jobId: string) {
  const job = await requireImportJob(env, principal, jobId, "editor");
  if (job.status === "planned") return getImportJob(env, principal, jobId);
  if (job.status !== "draft") throw new ApiError(409, "import_plan_conflict", "导入任务当前状态不能生成计划");
  if (job.totalItems === 0) throw new ApiError(422, "import_empty", "导入任务至少需要一个 Markdown 文件");

  const locked = await env.DB.prepare(`
    UPDATE transfer_jobs SET status = 'planning', updated_at = ?
    WHERE id = ? AND kind = 'import' AND status = 'draft'
  `).bind(nowIso(), jobId).run();
  if (Number(locked.meta.changes) !== 1) throw new ApiError(409, "import_plan_conflict", "导入任务已被其他请求开始规划");

  try {
    const rows = await env.DB.prepare(`${itemSelect()} WHERE job_id = ? ORDER BY relative_path`)
      .bind(jobId)
      .all<ImportItemRow>();
    let conflicts = 0;
    let invalid = 0;
    const now = nowIso();

    for (const item of rows.results ?? []) {
      const classified = await classifyItem(env, job, item);
      if (classified.action === "conflict" || classified.action === "conflict_deleted") conflicts += 1;
      if (classified.action === "invalid") invalid += 1;
      await env.DB.prepare(`
        UPDATE transfer_items
        SET action = ?, status = 'planned', target_note_id = ?, expected_version = ?,
            error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ? AND job_id = ?
      `).bind(
        classified.action,
        classified.targetNoteId,
        classified.expectedVersion,
        classified.errorCode,
        classified.errorMessage,
        now,
        item.id,
        jobId,
      ).run();
    }

    await env.DB.prepare(`
      UPDATE transfer_jobs
      SET status = 'planned', plan_version = plan_version + 1,
          conflict_items = ?, invalid_items = ?, updated_at = ?, last_error = NULL
      WHERE id = ? AND status = 'planning'
    `).bind(conflicts, invalid, now, jobId).run();
  } catch (error) {
    await env.DB.prepare(`
      UPDATE transfer_jobs SET status = 'failed', last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'planning'
    `).bind(error instanceof Error ? error.message.slice(0, 500) : "Import planning failed", nowIso(), jobId).run();
    throw error;
  }

  return getImportJob(env, principal, jobId);
}

export async function getImportJob(env: Env, principal: AdminPrincipal, jobId: string) {
  const job = await requireImportJob(env, principal, jobId, "viewer");
  const items = await env.DB.prepare(`${itemSelect()} WHERE job_id = ? ORDER BY relative_path`)
    .bind(jobId)
    .all<ImportItemRow>();
  return { ...job, items: items.results ?? [] };
}
