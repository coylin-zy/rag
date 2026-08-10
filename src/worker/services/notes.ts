import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";

import type { NoteSummary } from "@shared/contracts";
import type { AdminPrincipal, Env, KnowledgePrincipal, McpPrincipal } from "@worker/env";

import { createDb } from "../db/client";
import { noteVersions, notes } from "../db/schema";
import { requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { canonicalizeMarkdown, parseMarkdownDocument } from "../lib/markdown";
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
  };
}

async function getNoteRow(env: Env, noteId: string) {
  const db = createDb(env.DB);
  const note = await db.query.notes.findFirst({ where: eq(notes.id, noteId) });
  if (!note) throw new ApiError(404, "note_not_found", "文档不存在");
  return note;
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
  if (collectionIds.length === 0) return [];
  const limit = Math.min(options.limit ?? 100, 200);
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(notes)
    .where(and(
      inArray(notes.collectionId, collectionIds),
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
  const markdown = await getVersionMarkdown(env, note.id, note.version);
  return { ...toSummary(note), markdown };
}

export async function readNoteForCollections(env: Env, collectionIds: string[], noteId: string) {
  const note = await getNoteRow(env, noteId);
  if (!collectionIds.includes(note.collectionId) || note.status !== "published") {
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
  const document = canonicalizeMarkdown(markdownInput, { id, version });
  const contentHash = await sha256(document.markdown);
  const now = nowIso();
  const actor = principalActor(principal);
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

  const submittedCurrent = canonicalizeMarkdown(markdownInput, { id: noteId, version: expectedVersion });
  const storedCurrent = parseMarkdownDocument(await getVersionMarkdown(env, noteId, expectedVersion));
  const sameMetadata = submittedCurrent.frontmatter.title === storedCurrent.frontmatter.title
    && submittedCurrent.frontmatter.status === storedCurrent.frontmatter.status
    && JSON.stringify(submittedCurrent.frontmatter.tags) === JSON.stringify(storedCurrent.frontmatter.tags);
  if (sameMetadata && submittedCurrent.body === storedCurrent.body) return { ...toSummary(current), jobId: null };

  const version = expectedVersion + 1;
  const document = canonicalizeMarkdown(markdownInput, { id: noteId, version });
  const contentHash = await sha256(document.markdown);

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
  safety?: { expectedVersion: number; confirmationTitle: string },
): Promise<string> {
  const db = createDb(env.DB);
  const note = await getNoteRow(env, noteId);
  await requireKnowledgeRole(env, principal, note.collectionId, "editor");
  if (isMcpPrincipal(principal)) {
    if (!safety || safety.expectedVersion !== note.version) {
      throw new ApiError(409, "version_conflict", `文档已更新到版本 ${note.version}`);
    }
    if (safety.confirmationTitle !== note.title) {
      throw new ApiError(409, "note_confirmation_mismatch", "删除文档必须提供完全一致的标题确认");
    }
  }
  const now = nowIso();
  const actor = principalActor(principal);
  const result = await db.update(notes)
    .set({ status: "deleted", deletedAt: now, updatedAt: now, updatedBy: actor.authorId })
    .where(and(
      eq(notes.id, noteId),
      ne(notes.status, "deleted"),
      isMcpPrincipal(principal) ? eq(notes.version, safety?.expectedVersion ?? -1) : undefined,
    ));
  if (Number(result.meta.changes) !== 1) {
    throw new ApiError(409, "version_conflict", "文档在删除前已被其他操作更新");
  }
  const jobId = await enqueueJob(env, { type: "delete", noteId });
  await writeAudit(env, { actorType: actor.actorType, actorId: actor.actorId, action: "note.delete", resourceType: "note", resourceId: noteId, collectionIds: [note.collectionId], metadata: { version: note.version } });
  return jobId;
}

export async function listVersions(env: Env, principal: AdminPrincipal, noteId: string) {
  const note = await getNoteRow(env, noteId);
  await requireCollectionRole(env, principal, note.collectionId, "viewer");
  const db = createDb(env.DB);
  return db.select().from(noteVersions).where(eq(noteVersions.noteId, noteId)).orderBy(desc(noteVersions.version));
}

export async function restoreVersion(env: Env, principal: AdminPrincipal, noteId: string, sourceVersion: number) {
  const note = await getNoteRow(env, noteId);
  await requireCollectionRole(env, principal, note.collectionId, "editor");
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
