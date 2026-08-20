import { and, desc, eq } from "drizzle-orm";

import type { SourceMetadata } from "@shared/contracts";
import type { Env, KnowledgePrincipal } from "@worker/env";

import { createDb } from "../db/client";
import { noteVersions, notes } from "../db/schema";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { canonicalizeMarkdown, parseMarkdownDocument, serializeMarkdownDocument } from "../lib/markdown";
import { isKnowledgeAdmin, isMcpPrincipal, principalActor, requireKnowledgeRole } from "../lib/principal";
import { assertSupersedesTargets, freshnessWarnings } from "../lib/provenance";
import { nowIso, parseJson } from "../lib/utils";
import { enqueueJob } from "./jobs";
import { readNoteForAdmin, readNoteForCollections, readNoteForMcpAdmin } from "./notes";

export interface NoteVersionSummary {
  noteId: string;
  version: number;
  contentHash: string;
  title: string;
  tags: string[];
  createdAt: string;
  createdBy: string;
}

async function authorizeVersionRead(env: Env, principal: KnowledgePrincipal, noteId: string) {
  if (!isMcpPrincipal(principal)) return readNoteForAdmin(env, principal, noteId);
  if (isKnowledgeAdmin(principal)) return readNoteForMcpAdmin(env, principal, noteId);
  if (!principal.scopes.includes("knowledge:read")) {
    throw new ApiError(403, "scope_required", "Token 缺少 knowledge:read 权限");
  }
  return readNoteForCollections(env, principal.collectionIds, noteId);
}

function versionSummary(row: typeof noteVersions.$inferSelect): NoteVersionSummary {
  return {
    noteId: row.noteId,
    version: row.version,
    contentHash: row.contentHash,
    title: row.title,
    tags: parseJson<string[]>(row.tagsJson, []),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

async function readVersionObject(env: Env, noteId: string, version: number) {
  const db = createDb(env.DB);
  const row = await db.query.noteVersions.findFirst({
    where: and(eq(noteVersions.noteId, noteId), eq(noteVersions.version, version)),
  });
  if (!row) throw new ApiError(404, "note_version_not_found", "文档版本不存在或无权访问");
  const object = await env.NOTES.get(row.r2Key);
  if (!object) throw new ApiError(503, "note_object_missing", "R2 中缺少对应文档版本");
  const markdown = await object.text();
  if (await sha256(markdown) !== row.contentHash) {
    throw new ApiError(503, "note_hash_mismatch", "R2 文档内容与版本哈希不一致");
  }
  return { row, markdown };
}

export async function listNoteVersions(
  env: Env,
  principal: KnowledgePrincipal,
  noteId: string,
): Promise<NoteVersionSummary[]> {
  await authorizeVersionRead(env, principal, noteId);
  const db = createDb(env.DB);
  const rows = await db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)).orderBy(desc(noteVersions.version));
  return rows.map(versionSummary);
}

export async function readNoteVersion(
  env: Env,
  principal: KnowledgePrincipal,
  noteId: string,
  version: number,
) {
  const note = await authorizeVersionRead(env, principal, noteId);
  const { row, markdown } = await readVersionObject(env, noteId, version);
  const parsed = parseMarkdownDocument(markdown);
  const source = parsed.frontmatter.source ?? null;
  const reviewAfter = parsed.frontmatter.review_after ?? null;
  return {
    ...versionSummary(row),
    collectionId: note.collectionId,
    currentVersion: note.version,
    markdown,
    source: source as SourceMetadata | null,
    observedAt: source?.observed_at ?? null,
    reviewedAt: parsed.frontmatter.reviewed_at ?? null,
    reviewAfter,
    supersedes: parsed.frontmatter.supersedes,
    warnings: freshnessWarnings(reviewAfter),
  };
}

async function writeVersionObject(
  env: Env,
  input: { collectionId: string; noteId: string; version: number; markdown: string; contentHash: string },
): Promise<{ key: string; created: boolean }> {
  const key = `versions/${input.collectionId}/${input.noteId}/${input.version}.md`;
  const written = await env.NOTES.put(key, input.markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { noteId: input.noteId, version: String(input.version), sha256: input.contentHash },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!written) {
    const existing = await env.NOTES.head(key);
    if (existing?.customMetadata?.sha256 !== input.contentHash) {
      throw new ApiError(409, "version_conflict", "该文档版本已由其他更新占用");
    }
  }
  return { key, created: Boolean(written) };
}

async function removeUnusedVersionObject(
  env: Env,
  input: { key: string; created: boolean; noteId: string; version: number; contentHash: string },
): Promise<void> {
  if (!input.created) return;
  const reference = await env.DB.prepare(`
    SELECT
      n.version AS currentVersion,
      n.content_hash AS currentHash,
      v.content_hash AS versionHash
    FROM notes n
    LEFT JOIN note_versions v ON v.note_id = n.id AND v.version = ?
    WHERE n.id = ?
    LIMIT 1
  `).bind(input.version, input.noteId).first<{
    currentVersion: number;
    currentHash: string;
    versionHash: string | null;
  }>();
  if (
    reference?.versionHash === input.contentHash
    || (reference?.currentVersion === input.version && reference.currentHash === input.contentHash)
  ) return;
  await env.NOTES.delete(input.key);
}

export async function restoreNoteVersion(
  env: Env,
  principal: KnowledgePrincipal,
  noteId: string,
  expectedVersion: number,
  sourceVersion: number,
) {
  const db = createDb(env.DB);
  const note = await db.query.notes.findFirst({ where: eq(notes.id, noteId) });
  if (!note) throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
  await requireKnowledgeRole(env, principal, note.collectionId, "editor");
  if (note.status === "deleted") throw new ApiError(409, "note_deleted", "已删除文档必须从回收站恢复");
  if (note.version !== expectedVersion) {
    throw new ApiError(409, "version_conflict", `文档已更新到版本 ${note.version}，请重新查看 Diff`);
  }
  if (sourceVersion === expectedVersion) {
    throw new ApiError(409, "restore_source_is_current", "不能把当前版本恢复为自身");
  }
  if (sourceVersion > expectedVersion) {
    throw new ApiError(409, "restore_source_not_historical", "只能恢复当前版本之前的历史版本");
  }

  const { markdown: sourceMarkdown } = await readVersionObject(env, noteId, sourceVersion);
  const version = expectedVersion + 1;
  let restorationMarkdown = sourceMarkdown;
  if (isMcpPrincipal(principal)) {
    const parsed = parseMarkdownDocument(sourceMarkdown);
    if (note.reviewedAt) parsed.frontmatter.reviewed_at = note.reviewedAt;
    else delete parsed.frontmatter.reviewed_at;
    restorationMarkdown = serializeMarkdownDocument(parsed);
  }
  const document = canonicalizeMarkdown(restorationMarkdown, {
    id: noteId,
    version,
    reviewedAt: note.reviewedAt,
    allowReviewedAtChange: !isMcpPrincipal(principal),
  });
  await assertSupersedesTargets(env, note.collectionId, noteId, document.frontmatter.supersedes);
  const contentHash = await sha256(document.markdown);
  const actor = principalActor(principal);
  const now = nowIso();
  const source = document.frontmatter.source ?? null;
  const reviewedAt = document.frontmatter.reviewed_at ?? null;
  const reviewAfter = document.frontmatter.review_after ?? null;
  const supersedesJson = document.frontmatter.supersedes.length ? JSON.stringify(document.frontmatter.supersedes) : null;
  const versionObject = await writeVersionObject(env, {
    collectionId: note.collectionId,
    noteId,
    version,
    markdown: document.markdown,
    contentHash,
  });

  try {
    const [updateResult, insertResult] = await env.DB.batch([
      env.DB.prepare(`
        UPDATE notes
        SET title = ?, tags_json = ?, status = ?, version = ?, content_hash = ?,
            source_json = ?, observed_at = ?, reviewed_at = ?, review_after = ?, supersedes_json = ?,
            updated_at = ?, updated_by = ?
        WHERE id = ? AND version = ? AND status != 'deleted'
      `).bind(
        document.frontmatter.title,
        JSON.stringify(document.frontmatter.tags),
        document.frontmatter.status,
        version,
        contentHash,
        source ? JSON.stringify(source) : null,
        source?.observed_at ?? null,
        reviewedAt,
        reviewAfter,
        supersedesJson,
        now,
        actor.authorId,
        noteId,
        expectedVersion,
      ),
      env.DB.prepare(`
        INSERT INTO note_versions (note_id, version, r2_key, content_hash, title, tags_json, created_at, created_by)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM notes
          WHERE id = ? AND version = ? AND content_hash = ? AND updated_at = ? AND updated_by = ? AND status != 'deleted'
        )
      `).bind(
        noteId,
        version,
        versionObject.key,
        contentHash,
        document.frontmatter.title,
        JSON.stringify(document.frontmatter.tags),
        now,
        actor.authorId,
        noteId,
        version,
        contentHash,
        now,
        actor.authorId,
      ),
    ]);
    if (Number(updateResult.meta.changes) !== 1 || Number(insertResult.meta.changes) !== 1) {
      await removeUnusedVersionObject(env, {
        ...versionObject,
        noteId,
        version,
        contentHash,
      });
      throw new ApiError(409, "version_conflict", "文档在回滚期间被更新或移入回收站，请重新查看 Diff");
    }
  } catch (error) {
    await removeUnusedVersionObject(env, {
      ...versionObject,
      noteId,
      version,
      contentHash,
    }).catch(() => undefined);
    if (error instanceof ApiError) throw error;
    throw new ApiError(409, "version_conflict", "文档在回滚期间被其他操作更新，请重新查看 Diff");
  }

  await env.NOTES.put(`notes/${note.collectionId}/${noteId}/current.md`, document.markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { noteId, version: String(version), sha256: contentHash },
  });
  const jobId = await enqueueJob(env, { type: "index", noteId, version });
  await writeAudit(env, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "note.restore_version",
    resourceType: "note",
    resourceId: noteId,
    collectionIds: [note.collectionId],
    metadata: {
      sourceVersion,
      currentVersion: expectedVersion,
      restoredVersion: version,
      reviewedAtPreservedForAgent: isMcpPrincipal(principal),
      jobId,
    },
  });

  return {
    noteId,
    collectionId: note.collectionId,
    sourceVersion,
    previousVersion: expectedVersion,
    version,
    title: document.frontmatter.title,
    tags: document.frontmatter.tags,
    status: document.frontmatter.status,
    source,
    observedAt: source?.observed_at ?? null,
    reviewedAt,
    reviewAfter,
    supersedes: document.frontmatter.supersedes,
    warnings: freshnessWarnings(reviewAfter),
    contentHash,
    updatedAt: now,
    updatedBy: actor.authorId,
    jobId,
  };
}
