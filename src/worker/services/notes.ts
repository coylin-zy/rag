import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";

import type { NoteSummary, SourceMetadata, TrashedNoteSummary } from "@shared/contracts";
import type { AdminPrincipal, Env, KnowledgePrincipal, McpPrincipal } from "@worker/env";

import { createDb } from "../db/client";
import { noteVersions, notes } from "../db/schema";
import { requireAnyCollectionRole, requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { canonicalizeMarkdown, parseMarkdownDocument } from "../lib/markdown";
import { assertSupersedesTargets, freshnessWarnings } from "../lib/provenance";
import { isMcpPrincipal, principalActor, requireKnowledgeRole } from "../lib/principal";
import { nowIso, parseJson } from "../lib/utils";
import { enqueueJob } from "./jobs";

function toSummary(row: typeof notes.$inferSelect): NoteSummary {
  return {
    id: row.id,
    collectionId: row.collectionId,
    title: row.title,
    tags: parseJson<string[]>(row.tagsJson, []),
    status: row.status,
    version: row.version,
    indexedVersion: row.indexedVersion,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    source: parseJson<SourceMetadata | null>(row.sourceJson ?? "null", null),
    observedAt: row.observedAt,
    reviewedAt: row.reviewedAt,
    reviewAfter: row.reviewAfter,
    supersedes: parseJson<string[]>(row.supersedesJson ?? "[]", []),
    warnings: row.status === "deleted" ? [] : freshnessWarnings(row.reviewAfter),
  };
}

async function getNoteRow(env: Env, noteId: string) {
  const db = createDb(env.DB);
  const note = await db.query.notes.findFirst({ where: eq(notes.id, noteId) });
  if (!note) throw new ApiError(404, "note_not_found", "文档不存在");
  return note;
}

export async function getNoteVersionForMcp(env: Env, noteId: string) {
  return getNoteRow(env, noteId);
}

async function filterActiveCollectionIds(env: Env, collectionIds: string[]): Promise<string[]> {
  if (collectionIds.length === 0) return [];
  const placeholders = collectionIds.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id FROM collections WHERE id IN (${placeholders}) AND trashed_at IS NULL`,
  ).bind(...collectionIds).all<{ id: string }>();
  return result.results?.map((row) => row.id) ?? [];
}

async function getVersionMarkdown(env: Env, noteId: string, version: number): Promise<string> {
  const db = createDb(env.DB);
  const versionRow = await db.query.noteVersions.findFirst({
    where: and(eq(noteVersions.noteId, noteId), eq(noteVersions.version, version)),
  });
  if (!versionRow) throw new ApiError(404, "note_version_not_found", "文档版本不存在");
  const object = await env.NOTES.get(versionRow.r2Key);
  if (!object) throw new ApiError(503, "note_object_missing", "R2 中缺少对应文档版本");
  return object.text();
}

async function writeVersionObject(
  env: Env,
  input: { collectionId: string; noteId: string; version: number; markdown: string; contentHash: string },
): Promise<string> {
  const key = `versions/${input.collectionId}/${input.noteId}/${input.version}.md`;
  const options: R2PutOptions = {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { noteId: input.noteId, version: String(input.version), sha256: input.contentHash },
    onlyIf: { etagDoesNotMatch: "*" },
  };
  const written = await env.NOTES.put(key, input.markdown, options);
  if (!written) {
    const existing = await env.NOTES.head(key);
    if (existing?.customMetadata?.sha256 !== input.contentHash) {
      throw new ApiError(409, "version_conflict", "该文档版本已由其他更新占用");
    }
  }
  return key;
}

async function refreshCurrentObject(
  env: Env,
  collectionId: string,
  noteId: string,
  version: number,
  markdown: string,
  contentHash: string,
): Promise<void> {
  await env.NOTES.put(`notes/${collectionId}/${noteId}/current.md`, markdown, {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    customMetadata: { noteId, version: String(version), sha256: contentHash },
  });
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

export async function listNotes(env: Env, principal: AdminPrincipal, collectionId: string): Promise<NoteSummary[]> {
  await requireCollectionRole(env, principal, collectionId, "viewer");
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.collectionId, collectionId), ne(notes.status, "deleted")))
    .orderBy(desc(notes.updatedAt));
  return rows.map(toSummary);
}

export async function listNotesForCollections(
  env: Env,
  collectionIds: string[],
  options: { tags?: string[]; updatedAfter?: string; limit?: number; includeDrafts?: boolean } = {},
): Promise<NoteSummary[]> {
  const activeCollectionIds = await filterActiveCollectionIds(env, collectionIds);
  if (activeCollectionIds.length === 0) return [];
  const limit = Math.min(options.limit ?? 100, 200);
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(notes)
    .where(and(
      inArray(notes.collectionId, activeCollectionIds),
      options.includeDrafts ? ne(notes.status, "deleted") : eq(notes.status, "published"),
      options.updatedAfter ? gt(notes.updatedAt, options.updatedAfter) : undefined,
    ))
    .orderBy(desc(notes.updatedAt))
    .limit(options.tags?.length ? 1000 : limit);
  return rows
    .map(toSummary)
    .filter((note) => !options.tags?.length || options.tags.every((tag) => note.tags.includes(tag)))
    .slice(0, limit);
}

export async function readNoteForAdmin(env: Env, principal: AdminPrincipal, noteId: string) {
  const note = await getNoteRow(env, noteId);
  await requireCollectionRole(env, principal, note.collectionId, "viewer");
  if (note.status === "deleted") throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
  const markdown = await getVersionMarkdown(env, note.id, note.version);
  return { ...toSummary(note), markdown };
}

export async function readNoteForCollections(env: Env, collectionIds: string[], noteId: string) {
  const note = await getNoteRow(env, noteId);
  const activeCollectionIds = await filterActiveCollectionIds(env, collectionIds);
  if (!activeCollectionIds.includes(note.collectionId) || note.status !== "published") {
    throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
  }
  const markdown = await getVersionMarkdown(env, note.id, note.version);
  return { ...toSummary(note), markdown };
}

export async function readNoteForMcpAdmin(env: Env, principal: McpPrincipal, noteId: string) {
  const note = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, note.collectionId, "viewer");
  if (note.status === "deleted") throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
  const markdown = await getVersionMarkdown(env, note.id, note.version);
  return { ...toSummary(note), markdown };
}

export async function createNote(
  env: Env,
  principal: KnowledgePrincipal,
  collectionId: string,
  markdownInput: string,
): Promise<NoteSummary & { jobId: string }> {
  await requireKnowledgeRole(env, principal, collectionId, "editor");
  const db = createDb(env.DB);
  const id = crypto.randomUUID();
  const version = 1;
  const document = canonicalizeMarkdown(markdownInput, { id, version, reviewedAt: null });
  await assertSupersedesTargets(env, collectionId, id, document.frontmatter.supersedes);
  const contentHash = await sha256(document.markdown);
  const now = nowIso();
  const actor = principalActor(principal);
  const provenance = provenanceValues(document);
  const r2Key = await writeVersionObject(env, { collectionId, noteId: id, version, markdown: document.markdown, contentHash });

  await db.batch([
    db.insert(notes).values({
      id,
      collectionId,
      title: document.frontmatter.title,
      tagsJson: JSON.stringify(document.frontmatter.tags),
      status: document.frontmatter.status,
      version,
      indexedVersion: null,
      contentHash,
      createdAt: now,
      updatedAt: now,
      createdBy: actor.authorId,
      updatedBy: actor.authorId,
      ...provenance,
    }),
    db.insert(noteVersions).values({
      noteId: id,
      version,
      r2Key,
      contentHash,
      title: document.frontmatter.title,
      tagsJson: JSON.stringify(document.frontmatter.tags),
      createdAt: now,
      createdBy: actor.authorId,
    }),
  ]);
  await refreshCurrentObject(env, collectionId, id, version, document.markdown, contentHash);
  const jobId = await enqueueJob(env, { type: "index", noteId: id, version });
  await writeAudit(env, { actorType: actor.actorType, actorId: actor.actorId, action: "note.create", resourceType: "note", resourceId: id, collectionIds: [collectionId], metadata: { version } });

  const row = await getNoteRow(env, id);
  return { ...toSummary(row), jobId };
}

export async function updateNote(
  env: Env,
  principal: KnowledgePrincipal,
  noteId: string,
  expectedVersion: number,
  markdownInput: string,
): Promise<NoteSummary & { jobId: string | null }> {
  const db = createDb(env.DB);
  const current = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, current.collectionId, "editor");
  if (current.status === "deleted") throw new ApiError(409, "note_deleted", "已删除文档不能继续更新");
  if (current.version !== expectedVersion) {
    throw new ApiError(409, "version_conflict", `文档已更新到版本 ${current.version}`);
  }

  const submittedCurrent = canonicalizeMarkdown(markdownInput, {
    id: noteId,
    version: expectedVersion,
    reviewedAt: current.reviewedAt,
  });
  const storedCurrent = parseMarkdownDocument(await getVersionMarkdown(env, noteId, expectedVersion));
  const sameMetadata = submittedCurrent.frontmatter.title === storedCurrent.frontmatter.title
    && submittedCurrent.frontmatter.status === storedCurrent.frontmatter.status
    && JSON.stringify(submittedCurrent.frontmatter.tags) === JSON.stringify(storedCurrent.frontmatter.tags)
    && JSON.stringify(submittedCurrent.frontmatter.source ?? null) === JSON.stringify(storedCurrent.frontmatter.source ?? null)
    && (submittedCurrent.frontmatter.review_after ?? null) === (storedCurrent.frontmatter.review_after ?? null)
    && JSON.stringify(submittedCurrent.frontmatter.supersedes) === JSON.stringify(storedCurrent.frontmatter.supersedes);
  if (sameMetadata && submittedCurrent.body === storedCurrent.body) return { ...toSummary(current), jobId: null };

  const version = expectedVersion + 1;
  await assertSupersedesTargets(env, current.collectionId, noteId, canonicalizeMarkdown(markdownInput, { id: noteId, version }).frontmatter.supersedes);
  const document = canonicalizeMarkdown(markdownInput, { id: noteId, version, reviewedAt: current.reviewedAt });
  const contentHash = await sha256(document.markdown);
  const provenance = provenanceValues(document);

  const now = nowIso();
  const actor = principalActor(principal);
  const r2Key = await writeVersionObject(env, {
    collectionId: current.collectionId,
    noteId,
    version,
    markdown: document.markdown,
    contentHash,
  });

  try {
    await db.batch([
      db
        .update(notes)
        .set({
          title: document.frontmatter.title,
          tagsJson: JSON.stringify(document.frontmatter.tags),
          status: document.frontmatter.status,
          version,
          contentHash,
          updatedAt: now,
          updatedBy: actor.authorId,
          ...provenance,
        })
        .where(and(eq(notes.id, noteId), eq(notes.version, expectedVersion))),
      db.insert(noteVersions).values({
        noteId,
        version,
        r2Key,
        contentHash,
        title: document.frontmatter.title,
        tagsJson: JSON.stringify(document.frontmatter.tags),
        createdAt: now,
        createdBy: actor.authorId,
      }),
    ]);
  } catch {
    throw new ApiError(409, "version_conflict", "文档在保存期间被其他用户更新");
  }

  await refreshCurrentObject(env, current.collectionId, noteId, version, document.markdown, contentHash);
  const jobId = await enqueueJob(env, { type: "index", noteId, version });
  await writeAudit(env, { actorType: actor.actorType, actorId: actor.actorId, action: "note.update", resourceType: "note", resourceId: noteId, collectionIds: [current.collectionId], metadata: { version } });
  return { ...toSummary(await getNoteRow(env, noteId)), jobId };
}

export async function deleteNote(
  env: Env,
  principal: KnowledgePrincipal,
  noteId: string,
  safety: { expectedVersion: number; confirmationTitle?: string; reason?: string },
) {
  const db = createDb(env.DB);
  const note = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, note.collectionId, "editor");
  if (note.status === "deleted") throw new ApiError(409, "note_already_deleted", "文档已经在回收站中");
  if (safety.expectedVersion !== note.version) {
    throw new ApiError(409, "version_conflict", `文档已更新到版本 ${note.version}`);
  }
  if (isMcpPrincipal(principal)) {
    if (safety.confirmationTitle !== note.title) {
      throw new ApiError(409, "note_confirmation_mismatch", "移入回收站必须提供完全一致的文档标题");
    }
  }
  const now = nowIso();
  const actor = principalActor(principal);
  const result = await db.update(notes)
    .set({
      status: "deleted",
      deletedAt: now,
      deletedFromStatus: note.status,
      deletedBy: actor.authorId,
      deleteReason: safety.reason?.trim() ?? "",
      updatedAt: now,
      updatedBy: actor.authorId,
    })
    .where(and(
      eq(notes.id, noteId),
      ne(notes.status, "deleted"),
      eq(notes.version, safety.expectedVersion),
    ));
  if (Number(result.meta.changes) !== 1) {
    throw new ApiError(409, "version_conflict", "文档在删除前已被其他操作更新");
  }
  const jobId = await enqueueJob(env, { type: "delete", noteId });
  await writeAudit(env, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "note.delete",
    resourceType: "note",
    resourceId: noteId,
    collectionIds: [note.collectionId],
    metadata: { version: note.version, deletedAt: now, deletedFromStatus: note.status, reason: safety.reason?.trim() ?? "" },
  });
  return { jobId, noteId, version: note.version, deletedAt: now };
}

export async function listTrashedNotes(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
): Promise<TrashedNoteSummary[]> {
  await requireAnyCollectionRole(env, principal, collectionId, "viewer");
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.collectionId, collectionId), eq(notes.status, "deleted")))
    .orderBy(desc(notes.deletedAt));
  return rows.map((row) => ({
    ...toSummary(row),
    status: "deleted",
    deletedFromStatus: row.deletedFromStatus ?? "draft",
    deletedAt: row.deletedAt ?? row.updatedAt,
    deletedBy: row.deletedBy ?? row.updatedBy,
    deleteReason: row.deleteReason ?? "",
  }));
}

export async function restoreDeletedNote(
  env: Env,
  principal: KnowledgePrincipal,
  noteId: string,
  safety: { expectedVersion: number; expectedDeletedAt: string },
) {
  const note = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, note.collectionId, "editor");
  if (note.status !== "deleted" || !note.deletedAt) {
    throw new ApiError(409, "note_not_deleted", "文档不在回收站中");
  }
  if (note.version !== safety.expectedVersion || note.deletedAt !== safety.expectedDeletedAt) {
    throw new ApiError(409, "note_restore_conflict", "文档回收状态已变化，请刷新回收站后重试");
  }

  const restoredStatus = note.deletedFromStatus ?? "draft";
  const restoredAt = nowIso();
  const actor = principalActor(principal);
  const result = await env.DB.prepare(`
    UPDATE notes
    SET status = ?, deleted_at = NULL, deleted_from_status = NULL, deleted_by = NULL,
        delete_reason = NULL, updated_at = ?, updated_by = ?
    WHERE id = ? AND status = 'deleted' AND version = ? AND deleted_at = ?
  `).bind(restoredStatus, restoredAt, actor.authorId, noteId, safety.expectedVersion, safety.expectedDeletedAt).run();
  if (Number(result.meta.changes) !== 1) {
    throw new ApiError(409, "note_restore_conflict", "文档在恢复前已被其他操作更改");
  }

  const jobId = restoredStatus === "published"
    ? await enqueueJob(env, { type: "index", noteId, version: note.version })
    : null;
  await writeAudit(env, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "note.restore_deleted",
    resourceType: "note",
    resourceId: noteId,
    collectionIds: [note.collectionId],
    metadata: { version: note.version, expectedDeletedAt: safety.expectedDeletedAt, restoredStatus, restoredAt, jobId },
  });
  return { ...toSummary(await getNoteRow(env, noteId)), jobId, restoredAt };
}

export async function listVersions(env: Env, principal: KnowledgePrincipal, noteId: string) {
  const note = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, note.collectionId, "viewer");
  if (note.status === "deleted") throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
  const db = createDb(env.DB);
  return db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)).orderBy(desc(noteVersions.version));
}

export async function readNoteVersion(env: Env, principal: KnowledgePrincipal, noteId: string, version: number) {
  const note = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, note.collectionId, "viewer");
  if (note.status === "deleted") throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
  const markdown = await getVersionMarkdown(env, noteId, version);
  const row = await createDb(env.DB).query.noteVersions.findFirst({
    where: and(eq(noteVersions.noteId, noteId), eq(noteVersions.version, version)),
  });
  if (!row) throw new ApiError(404, "note_version_not_found", "文档版本不存在");
  return { ...row, markdown };
}

function diffLines(before: string[], after: string[]): Array<{ type: "same" | "add" | "remove"; text: string }> {
  const m = before.length;
  const n = after.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: Array<{ type: "same" | "add" | "remove"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (before[i] === after[j]) {
      result.push({ type: "same", text: before[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "remove", text: before[i] });
      i++;
    } else {
      result.push({ type: "add", text: after[j] });
      j++;
    }
  }
  while (i < m) { result.push({ type: "remove", text: before[i] }); i++; }
  while (j < n) { result.push({ type: "add", text: after[j] }); j++; }
  return result;
}

export interface DiffLine {
  type: "same" | "add" | "remove";
  text: string;
}

export async function diffNoteVersions(
  env: Env,
  principal: KnowledgePrincipal,
  noteId: string,
  fromVersion: number,
  toVersion: number,
): Promise<{ lines: DiffLine[] }> {
  const note = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, note.collectionId, "viewer");
  if (note.status === "deleted") throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
  const [fromMarkdown, toMarkdown] = await Promise.all([
    getVersionMarkdown(env, noteId, fromVersion),
    getVersionMarkdown(env, noteId, toVersion),
  ]);
  const before = fromMarkdown.replace(/\r\n/g, "\n").split("\n");
  const after = toMarkdown.replace(/\r\n/g, "\n").split("\n");
  return { lines: diffLines(before, after) };
}

export async function restoreVersion(env: Env, principal: KnowledgePrincipal, noteId: string, sourceVersion: number) {
  const note = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, note.collectionId, "editor");
  if (note.status === "deleted") throw new ApiError(409, "note_deleted", "已删除文档不能恢复版本");
  const markdown = await getVersionMarkdown(env, noteId, sourceVersion);
  return updateNote(env, principal, noteId, note.version, markdown);
}

export async function reindexNote(env: Env, principal: AdminPrincipal, noteId: string): Promise<string> {
  const note = await getNoteRow(env, noteId);
  await requireCollectionRole(env, principal, note.collectionId, "editor");
  if (note.status === "deleted") throw new ApiError(409, "note_deleted", "已删除文档不能重新索引");
  const jobId = await enqueueJob(env, { type: "index", noteId, version: note.version });
  await writeAudit(env, { actorType: "user", actorId: principal.email, action: "note.reindex", resourceType: "note", resourceId: noteId, collectionIds: [note.collectionId], metadata: { version: note.version, jobId } });
  return jobId;
}

export async function reviewNote(
  env: Env,
  principal: KnowledgePrincipal,
  noteId: string,
  expectedVersion: number,
  reviewAfter?: string | null,
) {
  const note = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, note.collectionId, "editor");
  if (note.status === "deleted") throw new ApiError(409, "note_deleted", "已删除文档不能复核");
  if (note.version !== expectedVersion) {
    throw new ApiError(409, "version_conflict", `文档已更新到版本 ${note.version}`);
  }

  const now = nowIso();
  const actor = principalActor(principal);
  const result = await env.DB.prepare(`
    UPDATE notes SET reviewed_at = ?, review_after = ?, updated_at = ?, updated_by = ?
    WHERE id = ? AND version = ? AND status != 'deleted'
  `).bind(now, reviewAfter ?? null, now, actor.authorId, noteId, expectedVersion).run();
  if (Number(result.meta.changes) !== 1) {
    throw new ApiError(409, "version_conflict", "文档在复核前已被其他操作更新");
  }

  // Update R2 frontmatter to match
  const markdown = await getVersionMarkdown(env, noteId, expectedVersion);
  const document = canonicalizeMarkdown(markdown, { id: noteId, version: expectedVersion, reviewedAt: now, allowReviewedAtChange: true });
  await refreshCurrentObject(env, note.collectionId, noteId, expectedVersion, document.markdown, await sha256(document.markdown));

  await writeAudit(env, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "note.review",
    resourceType: "note",
    resourceId: noteId,
    collectionIds: [note.collectionId],
    metadata: { version: expectedVersion, reviewedAt: now, reviewAfter: reviewAfter ?? null },
  });
  return toSummary(await getNoteRow(env, noteId));
}
