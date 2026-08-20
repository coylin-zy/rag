import type { AdminPrincipal, Env } from "@worker/env";

import { requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { canonicalizeMarkdown, parseMarkdownDocument, serializeMarkdownDocument } from "../lib/markdown";
import { assertSupersedesTargets } from "../lib/provenance";
import { nowIso } from "../lib/utils";
import { enqueueJob } from "./jobs";

function importedMarkdownWithoutManagedIdentity(markdown: string): string {
  const parsed = parseMarkdownDocument(markdown);
  delete parsed.frontmatter.id;
  delete parsed.frontmatter.version;
  return serializeMarkdownDocument(parsed);
}

function provenanceValues(document: ReturnType<typeof canonicalizeMarkdown>) {
  const source = document.frontmatter.source ?? null;
  return {
    sourceJson: source ? JSON.stringify(source) : null,
    observedAt: source?.observed_at ?? null,
    reviewedAt: document.frontmatter.reviewed_at ?? null,
    reviewAfter: document.frontmatter.review_after ?? null,
    supersedesJson: document.frontmatter.supersedes.length ? JSON.stringify(document.frontmatter.supersedes) : null,
  };
}

async function writeVersionObject(
  env: Env,
  input: { collectionId: string; noteId: string; version: number; markdown: string; contentHash: string },
) {
  const key = `versions/${input.collectionId}/${input.noteId}/${input.version}.md`;
  const written = await env.NOTES.put(key, input.markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { noteId: input.noteId, version: String(input.version), sha256: input.contentHash },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!written) {
    const existing = await env.NOTES.head(key);
    if (existing?.customMetadata?.sha256 !== input.contentHash) {
      throw new ApiError(409, "version_conflict", "导入目标版本已被其他更新占用");
    }
  }
  return { key, created: Boolean(written) };
}

async function refreshCurrentObject(
  env: Env,
  collectionId: string,
  noteId: string,
  version: number,
  markdown: string,
  contentHash: string,
) {
  await env.NOTES.put(`notes/${collectionId}/${noteId}/current.md`, markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { noteId, version: String(version), sha256: contentHash },
  });
}

async function cleanupUnusedVersion(
  env: Env,
  input: { key: string; created: boolean; noteId: string; version: number; contentHash: string },
) {
  await env.DB.prepare(`
    DELETE FROM note_versions
    WHERE note_id = ? AND version = ? AND content_hash = ?
      AND NOT EXISTS (
        SELECT 1 FROM notes WHERE id = ? AND version = ? AND content_hash = ?
      )
  `).bind(input.noteId, input.version, input.contentHash, input.noteId, input.version, input.contentHash).run();
  if (!input.created) return;
  const referenced = await env.DB.prepare(`
    SELECT 1 AS found
    FROM note_versions
    WHERE note_id = ? AND version = ? AND content_hash = ?
    UNION ALL
    SELECT 1 AS found
    FROM notes
    WHERE id = ? AND version = ? AND content_hash = ?
    LIMIT 1
  `).bind(input.noteId, input.version, input.contentHash, input.noteId, input.version, input.contentHash)
    .first<{ found: number }>();
  if (!referenced) await env.NOTES.delete(input.key);
}

export async function createImportedNote(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  externalPath: string,
  markdown: string,
) {
  await requireCollectionRole(env, principal, collectionId, "editor");
  const id = crypto.randomUUID();
  const version = 1;
  const normalizedInput = importedMarkdownWithoutManagedIdentity(markdown);
  const document = canonicalizeMarkdown(normalizedInput, {
    id,
    version,
    reviewedAt: null,
    allowReviewedAtChange: true,
  });
  await assertSupersedesTargets(env, collectionId, id, document.frontmatter.supersedes);
  const contentHash = await sha256(document.markdown);
  const provenance = provenanceValues(document);
  const now = nowIso();
  const versionObject = await writeVersionObject(env, {
    collectionId,
    noteId: id,
    version,
    markdown: document.markdown,
    contentHash,
  });

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO notes (
          id, collection_id, title, tags_json, status, version, indexed_version, content_hash,
          created_at, updated_at, created_by, updated_by,
          source_json, observed_at, reviewed_at, review_after, supersedes_json,
          external_path, sync_base_hash
        ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        collectionId,
        document.frontmatter.title,
        JSON.stringify(document.frontmatter.tags),
        document.frontmatter.status,
        contentHash,
        now,
        now,
        principal.email,
        principal.email,
        provenance.sourceJson,
        provenance.observedAt,
        provenance.reviewedAt,
        provenance.reviewAfter,
        provenance.supersedesJson,
        externalPath,
        contentHash,
      ),
      env.DB.prepare(`
        INSERT INTO note_versions (note_id, version, r2_key, content_hash, title, tags_json, created_at, created_by)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        versionObject.key,
        contentHash,
        document.frontmatter.title,
        JSON.stringify(document.frontmatter.tags),
        now,
        principal.email,
      ),
    ]);
  } catch (error) {
    if (versionObject.created) await env.NOTES.delete(versionObject.key).catch(() => undefined);
    throw new ApiError(409, "import_create_conflict", "导入创建文档时目标路径或版本发生冲突");
  }

  await refreshCurrentObject(env, collectionId, id, version, document.markdown, contentHash);
  const indexJobId = await enqueueJob(env, { type: "index", noteId: id, version });
  await writeAudit(env, {
    actorType: "user",
    actorId: principal.email,
    action: "note.import_create",
    resourceType: "note",
    resourceId: id,
    collectionIds: [collectionId],
    metadata: { version, externalPath, indexJobId },
  });
  return { id, collectionId, version, contentHash, externalPath, indexJobId };
}

export async function updateImportedNote(
  env: Env,
  principal: AdminPrincipal,
  noteId: string,
  expectedVersion: number,
  externalPath: string,
  markdown: string,
) {
  const current = await env.DB.prepare(`
    SELECT id, collection_id AS collectionId, status, version, reviewed_at AS reviewedAt
    FROM notes WHERE id = ? LIMIT 1
  `).bind(noteId).first<{
    id: string;
    collectionId: string;
    status: string;
    version: number;
    reviewedAt: string | null;
  }>();
  if (!current) throw new ApiError(404, "note_not_found", "导入目标文档不存在");
  await requireCollectionRole(env, principal, current.collectionId, "editor");
  if (current.status === "deleted") throw new ApiError(409, "note_deleted", "回收站文档不能被导入任务直接覆盖");
  if (current.version !== expectedVersion) throw new ApiError(409, "version_conflict", "导入计划使用的文档版本已经过期");

  const version = expectedVersion + 1;
  const normalizedInput = importedMarkdownWithoutManagedIdentity(markdown);
  const document = canonicalizeMarkdown(normalizedInput, {
    id: noteId,
    version,
    reviewedAt: current.reviewedAt,
    allowReviewedAtChange: true,
  });
  await assertSupersedesTargets(env, current.collectionId, noteId, document.frontmatter.supersedes);
  const contentHash = await sha256(document.markdown);
  const provenance = provenanceValues(document);
  const now = nowIso();
  const versionObject = await writeVersionObject(env, {
    collectionId: current.collectionId,
    noteId,
    version,
    markdown: document.markdown,
    contentHash,
  });

  try {
    const [historyResult, updateResult] = await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO note_versions (note_id, version, r2_key, content_hash, title, tags_json, created_at, created_by)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM notes WHERE id = ? AND version = ? AND status != 'deleted'
        )
        ON CONFLICT(note_id, version) DO NOTHING
      `).bind(
        noteId,
        version,
        versionObject.key,
        contentHash,
        document.frontmatter.title,
        JSON.stringify(document.frontmatter.tags),
        now,
        principal.email,
        noteId,
        expectedVersion,
      ),
      env.DB.prepare(`
        UPDATE notes
        SET title = ?, tags_json = ?, status = ?, version = ?, content_hash = ?,
            source_json = ?, observed_at = ?, reviewed_at = ?, review_after = ?, supersedes_json = ?,
            external_path = ?, sync_base_hash = ?, updated_at = ?, updated_by = ?
        WHERE id = ? AND version = ? AND status != 'deleted'
          AND EXISTS (
            SELECT 1 FROM note_versions
            WHERE note_id = ? AND version = ? AND content_hash = ?
          )
      `).bind(
        document.frontmatter.title,
        JSON.stringify(document.frontmatter.tags),
        document.frontmatter.status,
        version,
        contentHash,
        provenance.sourceJson,
        provenance.observedAt,
        provenance.reviewedAt,
        provenance.reviewAfter,
        provenance.supersedesJson,
        externalPath,
        contentHash,
        now,
        principal.email,
        noteId,
        expectedVersion,
        noteId,
        version,
        contentHash,
      ),
    ]);
    if (Number(historyResult.meta.changes) !== 1 || Number(updateResult.meta.changes) !== 1) {
      await cleanupUnusedVersion(env, { ...versionObject, noteId, version, contentHash });
      throw new ApiError(409, "version_conflict", "导入应用期间目标文档被其他操作更新");
    }
  } catch (error) {
    await cleanupUnusedVersion(env, { ...versionObject, noteId, version, contentHash }).catch(() => undefined);
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "version_conflict", "导入应用期间目标文档发生并发冲突");
  }

  await refreshCurrentObject(env, current.collectionId, noteId, version, document.markdown, contentHash);
  const indexJobId = await enqueueJob(env, { type: "index", noteId, version });
  await writeAudit(env, {
    actorType: "user",
    actorId: principal.email,
    action: "note.import_update",
    resourceType: "note",
    resourceId: noteId,
    collectionIds: [current.collectionId],
    metadata: { previousVersion: expectedVersion, version, externalPath, indexJobId },
  });
  return { id: noteId, collectionId: current.collectionId, version, contentHash, externalPath, indexJobId };
}
