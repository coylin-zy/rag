import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { CollectionSummary, Role } from "@shared/contracts";
import type { AdminPrincipal, Env } from "@worker/env";

import { createDb } from "../db/client";
import { collections, memberships, notes } from "../db/schema";
import { requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { ApiError } from "../lib/errors";
import { normalizeEmail, nowIso } from "../lib/utils";

function translateLastAdminError(error: unknown): never {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.message.includes("last_admin")) {
      throw new ApiError(409, "last_admin", "不能移除或降级知识库最后一名管理员");
    }
    current = current.cause;
  }
  throw error;
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<number> {
  let deleted = 0;
  while (true) {
    const page = await env.NOTES.list({ prefix, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length === 0) return deleted;
    await env.NOTES.delete(keys);
    deleted += keys.length;
    if (!page.truncated) return deleted;
  }
}

async function purgeCollectionSearchData(env: Env, collectionId: string): Promise<number> {
  let deleted = 0;
  while (true) {
    const result = await env.DB.prepare(
      "SELECT id FROM chunks WHERE collection_id = ? ORDER BY id LIMIT 100",
    ).bind(collectionId).all<{ id: string }>();
    const ids = result.results?.map((row) => row.id) ?? [];
    if (ids.length === 0) return deleted;

    try {
      await env.VECTOR_INDEX.deleteByIds(ids);
    } catch (error) {
      if (env.ENVIRONMENT !== "development") throw error;
    }

    const placeholders = ids.map(() => "?").join(",");
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${placeholders})`).bind(...ids),
      env.DB.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`).bind(...ids),
    ]);
    deleted += ids.length;
  }
}

export async function listCollections(env: Env, principal: AdminPrincipal): Promise<CollectionSummary[]> {
  const db = createDb(env.DB);
  const membershipRows = principal.bootstrapAdmin
    ? await db.select({ collectionId: collections.id, role: sql<Role>`'admin'` }).from(collections)
    : await db
        .select({ collectionId: memberships.collectionId, role: memberships.role })
        .from(memberships)
        .where(eq(memberships.userEmail, principal.email));

  if (membershipRows.length === 0) return [];
  const roleById = new Map(membershipRows.map((row) => [row.collectionId, row.role as Role]));
  const ids = [...roleById.keys()];
  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      updatedAt: collections.updatedAt,
      noteCount: sql<number>`sum(case when ${notes.status} != 'deleted' then 1 else 0 end)`,
    })
    .from(collections)
    .leftJoin(notes, eq(notes.collectionId, collections.id))
    .where(inArray(collections.id, ids))
    .groupBy(collections.id)
    .orderBy(desc(collections.updatedAt));

  return rows.map((row) => ({ ...row, noteCount: Number(row.noteCount), role: roleById.get(row.id) ?? "viewer" }));
}

export async function createCollection(
  env: Env,
  principal: AdminPrincipal,
  input: { name: string; description: string },
): Promise<CollectionSummary> {
  const db = createDb(env.DB);
  const id = crypto.randomUUID();
  const now = nowIso();
  await db.batch([
    db.insert(collections).values({ id, name: input.name, description: input.description, createdAt: now, updatedAt: now, createdBy: principal.email }),
    db.insert(memberships).values({ collectionId: id, userEmail: principal.email, role: "admin", createdAt: now }),
  ]);
  await writeAudit(env, { actorType: "user", actorId: principal.email, action: "collection.create", resourceType: "collection", resourceId: id, collectionIds: [id] });
  return { id, name: input.name, description: input.description, role: "admin", noteCount: 0, updatedAt: now };
}

export async function deleteCollection(env: Env, principal: AdminPrincipal, collectionId: string) {
  await requireCollectionRole(env, principal, collectionId, "admin");
  const collection = await env.DB.prepare(
    "SELECT id FROM collections WHERE id = ? LIMIT 1",
  ).bind(collectionId).first<{ id: string }>();
  if (!collection) throw new ApiError(404, "collection_not_found", "知识库不存在或无权访问");

  const now = nowIso();
  const usage = await env.DB.prepare(`
    SELECT
      (SELECT count(*) FROM notes WHERE collection_id = ? AND status != 'deleted') AS activeNoteCount,
      (SELECT count(*) FROM notes WHERE collection_id = ? AND status = 'deleted') AS deletedNoteCount,
      (SELECT count(*) FROM memory_proposals WHERE collection_id = ? AND status = 'pending') AS pendingProposalCount,
      (
        SELECT count(DISTINCT token.id)
        FROM api_tokens token, json_each(token.collection_ids_json) scope
        WHERE scope.value = ?
          AND token.revoked_at IS NULL
          AND (token.expires_at IS NULL OR token.expires_at > ?)
      ) AS activeTokenCount
  `).bind(collectionId, collectionId, collectionId, collectionId, now).first<{
    activeNoteCount: number;
    deletedNoteCount: number;
    pendingProposalCount: number;
    activeTokenCount: number;
  }>();

  if (!usage) throw new ApiError(500, "collection_usage_unavailable", "暂时无法检查知识库使用状态");
  if (Number(usage.activeNoteCount) > 0) {
    throw new ApiError(409, "collection_not_empty", "请先删除知识库中的全部文档");
  }
  if (Number(usage.activeTokenCount) > 0) {
    throw new ApiError(409, "collection_has_active_tokens", "请先撤销仍在使用此知识库的 MCP Token");
  }
  if (Number(usage.pendingProposalCount) > 0) {
    throw new ApiError(409, "collection_has_pending_proposals", "请先处理此知识库的待审核记忆提案");
  }

  const deletedSearchChunks = await purgeCollectionSearchData(env, collectionId);
  let deletedObjects = 0;
  for (const prefix of [`notes/${collectionId}/`, `versions/${collectionId}/`, `proposals/${collectionId}/`]) {
    deletedObjects += await deleteR2Prefix(env, prefix);
  }

  const auditId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM collections WHERE id = ?").bind(collectionId),
    env.DB.prepare(`
      INSERT INTO audit_logs (
        id, actor_type, actor_id, action, resource_type, resource_id,
        collection_ids_json, metadata_json, created_at
      ) VALUES (?, 'user', ?, 'collection.delete', 'collection', ?, ?, ?, ?)
    `).bind(
      auditId,
      principal.email,
      collectionId,
      JSON.stringify([collectionId]),
      JSON.stringify({
        deletedNoteHistory: Number(usage.deletedNoteCount),
        deletedObjects,
        deletedSearchChunks,
      }),
      now,
    ),
  ]);

  return { deleted: true, collectionId };
}

export async function listMembers(env: Env, principal: AdminPrincipal, collectionId: string) {
  await requireCollectionRole(env, principal, collectionId, "admin");
  const db = createDb(env.DB);
  return db.select().from(memberships).where(eq(memberships.collectionId, collectionId)).orderBy(memberships.userEmail);
}

export async function upsertMember(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  input: { email: string; role: Role },
) {
  await requireCollectionRole(env, principal, collectionId, "admin");
  const email = normalizeEmail(input.email);
  if (!email) throw new ApiError(422, "invalid_email", "成员邮箱不能为空");
  const db = createDb(env.DB);
  if (input.role !== "admin") {
    const current = await env.DB.prepare(`
      SELECT role,
             (SELECT count(*) FROM memberships WHERE collection_id = ? AND role = 'admin') AS adminCount
      FROM memberships WHERE collection_id = ? AND user_email = ?
    `).bind(collectionId, collectionId, email).first<{ role: Role; adminCount: number }>();
    if (current?.role === "admin" && Number(current.adminCount) <= 1) {
      throw new ApiError(409, "last_admin", "不能移除或降级知识库最后一名管理员");
    }
  }
  try {
    await db
      .insert(memberships)
      .values({ collectionId, userEmail: email, role: input.role, createdAt: nowIso() })
      .onConflictDoUpdate({ target: [memberships.collectionId, memberships.userEmail], set: { role: input.role } });
  } catch (error) {
    translateLastAdminError(error);
  }
  await writeAudit(env, {
    actorType: "user",
    actorId: principal.email,
    action: "member.upsert",
    resourceType: "collection",
    resourceId: collectionId,
    collectionIds: [collectionId],
    metadata: { email, role: input.role },
  });
  return { collectionId, userEmail: email, role: input.role };
}

export async function removeMember(env: Env, principal: AdminPrincipal, collectionId: string, emailInput: string) {
  await requireCollectionRole(env, principal, collectionId, "admin");
  const email = normalizeEmail(emailInput);
  const db = createDb(env.DB);
  const admins = await db
    .select({ email: memberships.userEmail })
    .from(memberships)
    .where(and(eq(memberships.collectionId, collectionId), eq(memberships.role, "admin")));
  if (admins.length === 1 && admins[0].email === email) throw new ApiError(409, "last_admin", "不能移除知识库最后一名管理员");
  try {
    await db.delete(memberships).where(and(eq(memberships.collectionId, collectionId), eq(memberships.userEmail, email)));
  } catch (error) {
    translateLastAdminError(error);
  }
  await writeAudit(env, { actorType: "user", actorId: principal.email, action: "member.remove", resourceType: "collection", resourceId: collectionId, collectionIds: [collectionId], metadata: { email } });
}
