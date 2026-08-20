import type { AdminPrincipal, Env } from "@worker/env";

import { requireAnyCollectionRole, requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { nowIso, parseJson } from "../lib/utils";

export type ExportKind = "portable" | "backup";

interface ExportJobRow {
  id: string;
  kind: "export_portable" | "export_backup";
  collectionId: string;
  status: string;
  manifestHash: string | null;
  verifiedAt: string | null;
  verificationHash: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  lastError: string | null;
}

interface ExportObjectRow {
  id: string;
  logicalPath: string;
  objectKind: string;
  noteId: string | null;
  noteVersion: number | null;
  r2Key: string | null;
  sha256: string;
  byteSize: number;
}

function exportKind(kind: ExportKind): ExportJobRow["kind"] {
  return kind === "portable" ? "export_portable" : "export_backup";
}

function safeSegment(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "collection";
}

function manifestKey(jobId: string) {
  return `exports/${jobId}/manifest.json`;
}

async function requireExportJob(env: Env, principal: AdminPrincipal, jobId: string) {
  const job = await env.DB.prepare(`
    SELECT id, kind, collection_id AS collectionId, status, manifest_hash AS manifestHash,
           verified_at AS verifiedAt, verification_hash AS verificationHash,
           created_at AS createdAt, updated_at AS updatedAt, created_by AS createdBy,
           last_error AS lastError
    FROM transfer_jobs
    WHERE id = ? AND kind IN ('export_portable', 'export_backup')
    LIMIT 1
  `).bind(jobId).first<ExportJobRow>();
  if (!job) throw new ApiError(404, "export_job_not_found", "导出任务不存在或无权访问");
  await requireAnyCollectionRole(env, principal, job.collectionId, "viewer");
  if (job.kind === "export_backup" && !principal.bootstrapAdmin) {
    throw new ApiError(403, "bootstrap_admin_required", "完整灾备只能由 bootstrap 管理员读取");
  }
  return job;
}

async function insertObject(env: Env, input: {
  jobId: string;
  logicalPath: string;
  objectKind: "current_markdown" | "history_markdown" | "collection_metadata" | "note_metadata" | "version_metadata";
  noteId?: string | null;
  noteVersion?: number | null;
  r2Key: string;
  sha256: string;
  byteSize: number;
}) {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO transfer_export_objects (
      id, job_id, logical_path, object_kind, note_id, note_version, r2_key, sha256, byte_size, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.jobId,
    input.logicalPath,
    input.objectKind,
    input.noteId ?? null,
    input.noteVersion ?? null,
    input.r2Key,
    input.sha256,
    input.byteSize,
    nowIso(),
  ).run();
  return id;
}

async function stageJsonObject(env: Env, input: {
  jobId: string;
  logicalPath: string;
  objectKind: "collection_metadata" | "note_metadata" | "version_metadata";
  value: unknown;
}) {
  const text = `${JSON.stringify(input.value, null, 2)}\n`;
  const hash = await sha256(text);
  const objectId = crypto.randomUUID();
  const key = `exports/${input.jobId}/objects/${objectId}.json`;
  await env.NOTES.put(key, text, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId: input.jobId, sha256: hash, logicalPath: input.logicalPath },
  });
  await env.DB.prepare(`
    INSERT INTO transfer_export_objects (
      id, job_id, logical_path, object_kind, note_id, note_version, r2_key, sha256, byte_size, created_at
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
  `).bind(
    objectId,
    input.jobId,
    input.logicalPath,
    input.objectKind,
    key,
    hash,
    new TextEncoder().encode(text).byteLength,
    nowIso(),
  ).run();
}

async function markdownObject(
  env: Env,
  jobId: string,
  logicalPath: string,
  objectKind: "current_markdown" | "history_markdown",
  noteId: string,
  version: number,
  r2Key: string,
  contentHash: string,
) {
  const object = await env.NOTES.head(r2Key);
  if (!object) throw new ApiError(503, "export_object_missing", `导出对象缺失：${logicalPath}`);
  const storedHash = object.customMetadata?.sha256;
  if (storedHash && storedHash !== contentHash) {
    throw new ApiError(503, "export_object_hash_mismatch", `导出对象哈希异常：${logicalPath}`);
  }
  await insertObject(env, {
    jobId,
    logicalPath,
    objectKind,
    noteId,
    noteVersion: version,
    r2Key,
    sha256: contentHash,
    byteSize: object.size,
  });
}

async function buildPortableObjects(env: Env, jobId: string, collectionId: string, collectionSlug: string) {
  const notes = await env.DB.prepare(`
    SELECT n.id, n.title, n.status, n.version, n.content_hash AS contentHash,
           n.external_path AS externalPath, n.source_json AS sourceJson,
           n.observed_at AS observedAt, n.reviewed_at AS reviewedAt, n.review_after AS reviewAfter,
           n.supersedes_json AS supersedesJson,
           v.r2_key AS r2Key
    FROM notes n
    JOIN note_versions v ON v.note_id = n.id AND v.version = n.version
    WHERE n.collection_id = ? AND n.status != 'deleted'
    ORDER BY COALESCE(n.external_path, n.id), n.id
  `).bind(collectionId).all<{
    id: string;
    title: string;
    status: string;
    version: number;
    contentHash: string;
    externalPath: string | null;
    sourceJson: string | null;
    observedAt: string | null;
    reviewedAt: string | null;
    reviewAfter: string | null;
    supersedesJson: string | null;
    r2Key: string;
  }>();

  const noteManifest: unknown[] = [];
  for (const note of notes.results ?? []) {
    const relativePath = note.externalPath ?? `${note.id}.md`;
    const logicalPath = `collections/${collectionSlug}/notes/${relativePath}`;
    await markdownObject(env, jobId, logicalPath, "current_markdown", note.id, note.version, note.r2Key, note.contentHash);
    noteManifest.push({
      id: note.id,
      path: relativePath,
      title: note.title,
      status: note.status,
      version: note.version,
      contentHash: note.contentHash,
      source: parseJson(note.sourceJson ?? "null", null),
      observedAt: note.observedAt,
      reviewedAt: note.reviewedAt,
      reviewAfter: note.reviewAfter,
      supersedes: parseJson<string[]>(note.supersedesJson ?? "[]", []),
    });
  }
  return noteManifest;
}

async function buildBackupMetadata(env: Env, jobId: string, collectionId: string, collectionSlug: string) {
  const collection = await env.DB.prepare(`
    SELECT id, name, description, created_at AS createdAt, updated_at AS updatedAt,
           created_by AS createdBy, trashed_at AS trashedAt, trashed_by AS trashedBy,
           trash_reason AS trashReason, purge_after AS purgeAfter
    FROM collections WHERE id = ? LIMIT 1
  `).bind(collectionId).first<Record<string, unknown>>();
  const memberships = await env.DB.prepare(`
    SELECT user_email AS email, role, created_at AS createdAt
    FROM memberships WHERE collection_id = ? ORDER BY user_email
  `).bind(collectionId).all<Record<string, unknown>>();
  const notes = await env.DB.prepare(`
    SELECT id, collection_id AS collectionId, title, tags_json AS tagsJson, status, version,
           indexed_version AS indexedVersion, content_hash AS contentHash,
           created_at AS createdAt, updated_at AS updatedAt, created_by AS createdBy, updated_by AS updatedBy,
           deleted_at AS deletedAt, deleted_from_status AS deletedFromStatus, deleted_by AS deletedBy,
           delete_reason AS deleteReason, source_json AS sourceJson, observed_at AS observedAt,
           reviewed_at AS reviewedAt, review_after AS reviewAfter, supersedes_json AS supersedesJson,
           external_path AS externalPath, sync_base_hash AS syncBaseHash
    FROM notes WHERE collection_id = ? ORDER BY id
  `).bind(collectionId).all<Record<string, unknown>>();
  const versions = await env.DB.prepare(`
    SELECT v.note_id AS noteId, v.version, v.content_hash AS contentHash,
           v.title, v.tags_json AS tagsJson, v.created_at AS createdAt, v.created_by AS createdBy,
           v.r2_key AS r2Key
    FROM note_versions v
    JOIN notes n ON n.id = v.note_id
    WHERE n.collection_id = ?
    ORDER BY v.note_id, v.version
  `).bind(collectionId).all<{
    noteId: string;
    version: number;
    contentHash: string;
    title: string;
    tagsJson: string;
    createdAt: string;
    createdBy: string;
    r2Key: string;
  }>();

  await stageJsonObject(env, {
    jobId,
    logicalPath: "recovery/collections.json",
    objectKind: "collection_metadata",
    value: { collection, memberships: memberships.results ?? [] },
  });
  await stageJsonObject(env, {
    jobId,
    logicalPath: "recovery/notes.json",
    objectKind: "note_metadata",
    value: notes.results ?? [],
  });
  await stageJsonObject(env, {
    jobId,
    logicalPath: "recovery/versions.json",
    objectKind: "version_metadata",
    value: (versions.results ?? []).map(({ r2Key: _r2Key, ...version }) => version),
  });

  for (const version of versions.results ?? []) {
    await markdownObject(
      env,
      jobId,
      `history/${version.noteId}/${version.version}.md`,
      "history_markdown",
      version.noteId,
      version.version,
      version.r2Key,
      version.contentHash,
    );
  }

  return { collectionSlug, noteCount: notes.results?.length ?? 0, versionCount: versions.results?.length ?? 0 };
}

async function freezeManifest(env: Env, job: ExportJobRow, collection: { id: string; name: string }, noteManifest: unknown[]) {
  const objects = await env.DB.prepare(`
    SELECT id, logical_path AS logicalPath, object_kind AS objectKind,
           note_id AS noteId, note_version AS noteVersion,
           sha256, byte_size AS byteSize
    FROM transfer_export_objects WHERE job_id = ? ORDER BY logical_path, id
  `).bind(job.id).all<{
    id: string;
    logicalPath: string;
    objectKind: string;
    noteId: string | null;
    noteVersion: number | null;
    sha256: string;
    byteSize: number;
  }>();
  const manifest = {
    formatVersion: 1,
    kind: job.kind === "export_backup" ? "full_backup" : "portable",
    createdAt: job.createdAt,
    collection,
    notes: noteManifest,
    includesHistory: job.kind === "export_backup",
    includesTrash: job.kind === "export_backup",
    objects: objects.results ?? [],
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const hash = await sha256(text);
  await env.NOTES.put(manifestKey(job.id), text, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { jobId: job.id, sha256: hash, kind: job.kind },
  });
  await env.DB.prepare(`
    UPDATE transfer_jobs
    SET status = 'completed', manifest_hash = ?,
        total_items = (SELECT COUNT(*) FROM transfer_export_objects WHERE job_id = ?),
        total_bytes = (SELECT COALESCE(SUM(byte_size), 0) FROM transfer_export_objects WHERE job_id = ?),
        completed_items = (SELECT COUNT(*) FROM transfer_export_objects WHERE job_id = ?),
        updated_at = ?, completed_at = ?, last_error = NULL
    WHERE id = ?
  `).bind(hash, job.id, job.id, job.id, nowIso(), nowIso(), job.id).run();
  return { manifest, hash };
}

export async function createExportJob(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  kind: ExportKind,
) {
  if (kind === "backup") {
    if (!principal.bootstrapAdmin) throw new ApiError(403, "bootstrap_admin_required", "完整灾备只能由 bootstrap 管理员创建");
    await requireAnyCollectionRole(env, principal, collectionId, "admin");
  } else {
    await requireCollectionRole(env, principal, collectionId, "editor");
  }

  const collection = await env.DB.prepare("SELECT id, name FROM collections WHERE id = ? LIMIT 1")
    .bind(collectionId).first<{ id: string; name: string }>();
  if (!collection) throw new ApiError(404, "collection_not_found", "知识库不存在或无权访问");
  const id = crypto.randomUUID();
  const now = nowIso();
  await env.DB.prepare(`
    INSERT INTO transfer_jobs (
      id, kind, collection_id, status, plan_version, total_items, completed_items,
      failed_items, conflict_items, invalid_items, total_bytes,
      created_at, updated_at, created_by, started_at
    ) VALUES (?, ?, ?, 'processing', 0, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?)
  `).bind(id, exportKind(kind), collectionId, now, now, principal.email, now).run();

  const job = await env.DB.prepare(`
    SELECT id, kind, collection_id AS collectionId, status, manifest_hash AS manifestHash,
           verified_at AS verifiedAt, verification_hash AS verificationHash,
           created_at AS createdAt, updated_at AS updatedAt, created_by AS createdBy,
           last_error AS lastError
    FROM transfer_jobs WHERE id = ?
  `).bind(id).first<ExportJobRow>();
  if (!job) throw new ApiError(500, "export_job_create_failed", "导出任务创建失败");

  try {
    const slug = safeSegment(collection.name);
    const noteManifest = await buildPortableObjects(env, id, collectionId, slug);
    if (kind === "backup") await buildBackupMetadata(env, id, collectionId, slug);
    const frozen = await freezeManifest(env, job, collection, noteManifest);
    await writeAudit(env, {
      actorType: "user",
      actorId: principal.email,
      action: kind === "backup" ? "export.backup_create" : "export.portable_create",
      resourceType: "transfer_job",
      resourceId: id,
      collectionIds: [collectionId],
      metadata: { manifestHash: frozen.hash, objectCount: frozen.manifest.objects.length },
    });
    return { id, kind, status: "completed" as const, manifestHash: frozen.hash };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE transfer_jobs SET status = 'failed', last_error = ?, updated_at = ?, completed_at = ? WHERE id = ?
    `).bind(error instanceof Error ? error.message.slice(0, 500) : "Export failed", nowIso(), nowIso(), id).run();
    throw error;
  }
}

export async function readExportManifest(env: Env, principal: AdminPrincipal, jobId: string) {
  const job = await requireExportJob(env, principal, jobId);
  if (job.status !== "completed" || !job.manifestHash) throw new ApiError(409, "export_not_ready", "导出任务尚未完成");
  const object = await env.NOTES.get(manifestKey(jobId));
  if (!object) throw new ApiError(503, "export_manifest_missing", "导出 manifest 不存在");
  const text = await object.text();
  if (await sha256(text) !== job.manifestHash) throw new ApiError(503, "export_manifest_hash_mismatch", "导出 manifest 哈希校验失败");
  return { job, manifest: JSON.parse(text) as unknown, manifestHash: job.manifestHash };
}

export async function readExportObject(env: Env, principal: AdminPrincipal, jobId: string, objectId: string) {
  const job = await requireExportJob(env, principal, jobId);
  if (job.status !== "completed") throw new ApiError(409, "export_not_ready", "导出任务尚未完成");
  const row = await env.DB.prepare(`
    SELECT id, logical_path AS logicalPath, object_kind AS objectKind,
           note_id AS noteId, note_version AS noteVersion, r2_key AS r2Key,
           sha256, byte_size AS byteSize
    FROM transfer_export_objects WHERE id = ? AND job_id = ? LIMIT 1
  `).bind(objectId, jobId).first<ExportObjectRow>();
  if (!row?.r2Key) throw new ApiError(404, "export_object_not_found", "导出对象不存在或无权访问");
  const object = await env.NOTES.get(row.r2Key);
  if (!object) throw new ApiError(503, "export_object_missing", "导出对象在 R2 中不存在");
  const bytes = await object.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== row.sha256) throw new ApiError(503, "export_object_hash_mismatch", "导出对象哈希校验失败");
  return { row, bytes };
}

export async function verifyBackupReport(
  env: Env,
  principal: AdminPrincipal,
  jobId: string,
  input: { manifestHash: string; reportHash: string },
) {
  if (!principal.bootstrapAdmin) throw new ApiError(403, "bootstrap_admin_required", "只有 bootstrap 管理员可以登记灾备验证结果");
  const job = await requireExportJob(env, principal, jobId);
  if (job.kind !== "export_backup") throw new ApiError(409, "backup_required", "只有完整灾备任务可以登记恢复验证");
  if (job.status !== "completed" || !job.manifestHash) throw new ApiError(409, "export_not_ready", "完整灾备尚未完成");
  if (input.manifestHash !== job.manifestHash) throw new ApiError(409, "backup_manifest_changed", "验证报告对应的 manifest 与服务端不一致");
  const now = nowIso();
  await env.DB.prepare(`
    UPDATE transfer_jobs SET verified_at = ?, verified_by = ?, verification_hash = ?, updated_at = ?
    WHERE id = ? AND kind = 'export_backup' AND manifest_hash = ?
  `).bind(now, principal.email, input.reportHash, now, jobId, job.manifestHash).run();
  await writeAudit(env, {
    actorType: "user",
    actorId: principal.email,
    action: "export.backup_verify",
    resourceType: "transfer_job",
    resourceId: jobId,
    collectionIds: [job.collectionId],
    metadata: { manifestHash: job.manifestHash, reportHash: input.reportHash, verifiedAt: now },
  });
  return { jobId, manifestHash: job.manifestHash, reportHash: input.reportHash, verifiedAt: now };
}
