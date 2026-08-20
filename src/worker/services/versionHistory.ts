import { and, desc, eq } from "drizzle-orm";

import type { AdminPrincipal, Env, KnowledgePrincipal, McpPrincipal } from "@worker/env";

import { createDb } from "../db/client";
import { noteVersions, notes } from "../db/schema";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { canonicalizeMarkdown } from "../lib/markdown";
import { isKnowledgeAdmin, isMcpPrincipal, principalActor, requireKnowledgeRole } from "../lib/principal";
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
  return {
    ...versionSummary(row),
    collectionId: note.collectionId,
    currentVersion: note.version,
    markdown,
  };
}

async function writeVersionObject(
  env: Env,
  input: { collectionId: string; noteId: string; version: number; markdown: string; contentHash: string },
): Promise<string> {
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
  return key;
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

  const { markdown: sourceMarkdown } = await readVersionObject(env, noteId, sourceVersion);
  const version = expectedVersion + 1;
  const document = canonicalizeMarkdown(sourceMarkdown, { id: noteId, version });
  const contentHash = await sha256(document.markdown);
  const actor = principalActor(principal);
  const now = nowIso();
  const r2Key = await writeVersionObject(env, {
    collectionId: note.collectionId,
    noteId,
    version,
    markdown: document.markdown,
    contentHash,
  });

  try {
    await db.batch([
      db.update(notes).set({
        title: document.frontmatter.title,
        tagsJson: JSON.stringify(document.frontmatter.tags),
        status: document.frontmatter.status,
        version,
        contentHash,
        updatedAt: now,
        updatedBy: actor.authorId,
      }).where(and(eq(notes.id, noteId), eq(notes.version, expectedVersion))),
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
    metadata: { sourceVersion, currentVersion: expectedVersion, restoredVersion: version, jobId },
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
    contentHash,
    updatedAt: now,
    updatedBy: actor.authorId,
    jobId,
  };
}

export function isMcpVersionPrincipal(principal: KnowledgePrincipal): principal is McpPrincipal {
  return isMcpPrincipal(principal);
}

export function isAdminVersionPrincipal(principal: KnowledgePrincipal): principal is AdminPrincipal {
  return !isMcpPrincipal(principal);
}
