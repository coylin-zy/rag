import type { SourceMetadata } from "@shared/contracts";
import type { AdminPrincipal, Env, McpPrincipal } from "@worker/env";

import { createDb } from "../db/client";
import { noteVersions, notes } from "../db/schema";
import { requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { canonicalizeMarkdown, parseMarkdownDocument, serializeMarkdownDocument } from "../lib/markdown";
import { requireKnowledgeRole } from "../lib/principal";
import { freshnessWarnings } from "../lib/provenance";
import { nowIso, parseJson } from "../lib/utils";
import { enqueueJob } from "./jobs";

export interface ReviewDueItem {
  id: string;
  collectionId: string;
  title: string;
  version: number;
  source: SourceMetadata | null;
  observedAt: string | null;
  reviewedAt: string | null;
  reviewAfter: string;
  warnings: ["review_due"];
}

function reviewDueItem(row: {
  id: string;
  collectionId: string;
  title: string;
  version: number;
  sourceJson: string | null;
  observedAt: string | null;
  reviewedAt: string | null;
  reviewAfter: string | null;
}): ReviewDueItem {
  if (!row.reviewAfter) throw new ApiError(500, "review_due_invariant", "待复核文档缺少 review_after");
  return {
    id: row.id,
    collectionId: row.collectionId,
    title: row.title,
    version: row.version,
    source: parseJson<SourceMetadata | null>(row.sourceJson ?? "null", null),
    observedAt: row.observedAt,
    reviewedAt: row.reviewedAt,
    reviewAfter: row.reviewAfter,
    warnings: ["review_due"],
  };
}

async function queryReviewDue(env: Env, collectionIds: string[], includeDrafts: boolean, limit: number): Promise<ReviewDueItem[]> {
  if (collectionIds.length === 0) return [];
  const placeholders = collectionIds.map(() => "?").join(",");
  const statusClause = includeDrafts ? "n.status != 'deleted'" : "n.status = 'published'";
  const result = await env.DB.prepare(`
    SELECT n.id, n.collection_id AS collectionId, n.title, n.version,
           n.source_json AS sourceJson, n.observed_at AS observedAt,
           n.reviewed_at AS reviewedAt, n.review_after AS reviewAfter
    FROM notes n
    JOIN collections c ON c.id = n.collection_id AND c.trashed_at IS NULL
    WHERE n.collection_id IN (${placeholders})
      AND ${statusClause}
      AND n.review_after IS NOT NULL
      AND n.review_after < ?
    ORDER BY n.review_after ASC
    LIMIT ?
  `).bind(...collectionIds, nowIso(), Math.min(Math.max(limit, 1), 200)).all<{
    id: string;
    collectionId: string;
    title: string;
    version: number;
    sourceJson: string | null;
    observedAt: string | null;
    reviewedAt: string | null;
    reviewAfter: string | null;
  }>();
  return (result.results ?? []).map(reviewDueItem);
}

export async function listReviewDueForAdmin(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  limit = 100,
): Promise<ReviewDueItem[]> {
  await requireCollectionRole(env, principal, collectionId, "viewer");
  return queryReviewDue(env, [collectionId], true, limit);
}

export async function listReviewDueForMcp(
  env: Env,
  principal: McpPrincipal,
  limit = 100,
): Promise<ReviewDueItem[]> {
  let collectionIds = principal.collectionIds;
  if (principal.scopes.includes("knowledge:admin")) {
    const result = await env.DB.prepare("SELECT id FROM collections WHERE trashed_at IS NULL ORDER BY id").all<{ id: string }>();
    collectionIds = result.results?.map((row) => row.id) ?? [];
  }
  return queryReviewDue(env, collectionIds, false, limit);
}

async function getCurrentVersionMarkdown(env: Env, noteId: string, version: number): Promise<string> {
  const db = createDb(env.DB);
  const versionRow = await db.query.noteVersions.findFirst({
    where: (table, { and, eq }) => and(eq(table.noteId, noteId), eq(table.version, version)),
  });
  if (!versionRow) throw new ApiError(404, "note_version_not_found", "文档版本不存在");
  const object = await env.NOTES.get(versionRow.r2Key);
  if (!object) throw new ApiError(503, "note_object_missing", "R2 中缺少对应文档版本");
  return object.text();
}

export async function reviewNote(
  env: Env,
  principal: AdminPrincipal,
  noteId: string,
  expectedVersion: number,
  nextReviewAfter: string | null,
) {
  const db = createDb(env.DB);
  const note = await db.query.notes.findFirst({ where: (table, { eq }) => eq(table.id, noteId) });
  if (!note) throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
  await requireCollectionRole(env, principal, note.collectionId, "editor");
  if (note.status === "deleted") throw new ApiError(409, "note_deleted", "已删除文档不能标记复核");
  if (note.version !== expectedVersion) {
    throw new ApiError(409, "version_conflict", `文档已更新到版本 ${note.version}，请刷新后重试`);
  }

  const sourceMarkdown = await getCurrentVersionMarkdown(env, noteId, expectedVersion);
  const parsed = parseMarkdownDocument(sourceMarkdown);
  const reviewedAt = nowIso();
  parsed.frontmatter.reviewed_at = reviewedAt;
  parsed.frontmatter.review_after = nextReviewAfter;
  const version = expectedVersion + 1;
  const document = canonicalizeMarkdown(serializeMarkdownDocument(parsed), {
    id: noteId,
    version,
    reviewedAt: note.reviewedAt,
    allowReviewedAtChange: true,
  });
  const contentHash = await sha256(document.markdown);
  const r2Key = `versions/${note.collectionId}/${noteId}/${version}.md`;
  const written = await env.NOTES.put(r2Key, document.markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { noteId, version: String(version), sha256: contentHash },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!written) {
    const existing = await env.NOTES.head(r2Key);
    if (existing?.customMetadata?.sha256 !== contentHash) {
      throw new ApiError(409, "version_conflict", "目标复核版本已被其他操作占用");
    }
  }

  const updatedAt = nowIso();
  const updated = await env.DB.prepare(`
    UPDATE notes
    SET version = ?, content_hash = ?, reviewed_at = ?, review_after = ?, updated_at = ?, updated_by = ?
    WHERE id = ? AND version = ? AND status != 'deleted'
  `).bind(
    version,
    contentHash,
    reviewedAt,
    nextReviewAfter,
    updatedAt,
    principal.email,
    noteId,
    expectedVersion,
  ).run();
  if (Number(updated.meta.changes) !== 1) {
    const referenced = await env.DB.prepare("SELECT 1 AS found FROM note_versions WHERE note_id = ? AND version = ? LIMIT 1")
      .bind(noteId, version)
      .first<{ found: number }>();
    if (!referenced) await env.NOTES.delete(r2Key).catch(() => undefined);
    throw new ApiError(409, "version_conflict", "文档在复核期间被其他操作更新，请刷新后重试");
  }

  try {
    await db.insert(noteVersions).values({
      noteId,
      version,
      r2Key,
      contentHash,
      title: document.frontmatter.title,
      tagsJson: JSON.stringify(document.frontmatter.tags),
      createdAt: updatedAt,
      createdBy: principal.email,
    });
  } catch {
    throw new ApiError(409, "version_conflict", "复核版本历史写入冲突");
  }

  await env.NOTES.put(`notes/${note.collectionId}/${noteId}/current.md`, document.markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { noteId, version: String(version), sha256: contentHash },
  });
  const jobId = await enqueueJob(env, { type: "index", noteId, version });
  await writeAudit(env, {
    actorType: "user",
    actorId: principal.email,
    action: "note.review",
    resourceType: "note",
    resourceId: noteId,
    collectionIds: [note.collectionId],
    metadata: { previousVersion: expectedVersion, version, reviewedAt, reviewAfter: nextReviewAfter, jobId },
  });

  return {
    noteId,
    collectionId: note.collectionId,
    version,
    reviewedAt,
    reviewAfter: nextReviewAfter,
    warnings: freshnessWarnings(nextReviewAfter),
    jobId,
  };
}
