import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { CollectionSummary, Role, TrashedCollectionSummary } from "@shared/contracts";
import type { AdminPrincipal, Env, KnowledgePrincipal } from "@worker/env";

import { createDb } from "../db/client";
import { collections, memberships, notes } from "../db/schema";
import { requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { ApiError } from "../lib/errors";
import { isKnowledgeAdmin, isMcpPrincipal, principalActor, requireKnowledgeRole, requireTrashedKnowledgeRole } from "../lib/principal";
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

export async function listCollections(env: Env, principal: AdminPrincipal): Promise<CollectionSummary[]> {
  const db = createDb(env.DB);
  const membershipRows = principal.bootstrapAdmin
    ? await db
        .select({ collectionId: collections.id, role: sql<Role>`'admin'` })
        .from(collections)
        .where(isNull(collections.trashedAt))
    : await db
        .select({ collectionId: memberships.collectionId, role: memberships.role })
        .from(memberships)
        .innerJoin(collections, eq(collections.id, memberships.collectionId))
        .where(and(eq(memberships.userEmail, principal.email), isNull(collections.trashedAt)));

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
    .where(and(inArray(collections.id, ids), isNull(collections.trashedAt)))
    .groupBy(collections.id)
    .orderBy(desc(collections.updatedAt));

  return rows.map((row) => ({ ...row, noteCount: Number(row.noteCount), role: roleById.get(row.id) ?? "viewer" }));
}

export async function listTrashedCollections(env: Env, principal: AdminPrincipal): Promise<TrashedCollectionSummary[]> {
  const db = createDb(env.DB);
  const membershipRows = principal.bootstrapAdmin
    ? await db
        .select({ collectionId: collections.id, role: sql<Role>`'admin'` })
        .from(collections)
        .where(isNotNull(collections.trashedAt))
    : await db
        .select({ collectionId: memberships.collectionId, role: memberships.role })
        .from(memberships)
        .innerJoin(collections, eq(collections.id, memberships.collectionId))
        .where(and(eq(memberships.userEmail, principal.email), isNotNull(collections.trashedAt)));
  if (membershipRows.length === 0) return [];

  const roleById = new Map(membershipRows.map((row) => [row.collectionId, row.role as Role]));
  const rows = await db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      updatedAt: collections.updatedAt,
      trashedAt: collections.trashedAt,
      trashedBy: collections.trashedBy,
      trashReason: collections.trashReason,
      purgeAfter: collections.purgeAfter,
      noteCount: sql<number>`sum(case when ${notes.status} != 'deleted' then 1 else 0 end)`,
      deletedNoteCount: sql<number>`sum(case when ${notes.status} = 'deleted' then 1 else 0 end)`,
    })
    .from(collections)
    .leftJoin(notes, eq(notes.collectionId, collections.id))
    .where(and(inArray(collections.id, [...roleById.keys()]), isNotNull(collections.trashedAt)))
    .groupBy(collections.id)
    .orderBy(desc(collections.trashedAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    updatedAt: row.updatedAt,
    role: roleById.get(row.id) ?? "viewer",
    noteCount: Number(row.noteCount),
    deletedNoteCount: Number(row.deletedNoteCount),
    trashedAt: row.trashedAt ?? "",
    trashedBy: row.trashedBy ?? "",
    trashReason: row.trashReason ?? "",
    purgeAfter: row.purgeAfter ?? "",
  }));
}

export async function createCollection(
  env: Env,
  principal: KnowledgePrincipal,
  input: { name: string; description: string },
): Promise<CollectionSummary> {
  if (isMcpPrincipal(principal) && !isKnowledgeAdmin(principal)) {
    throw new ApiError(403, "scope_required", "Token 缺少 knowledge:admin 权限");
  }
  const db = createDb(env.DB);
  const id = crypto.randomUUID();
  const now = nowIso();
  const actor = principalActor(principal);
  const ownerEmail = isMcpPrincipal(principal) ? principal.createdBy : principal.email;
  await db.batch([
    db.insert(collections).values({ id, name: input.name, description: input.description, createdAt: now, updatedAt: now, createdBy: actor.authorId }),
    db.insert(memberships).values({ collectionId: id, userEmail: ownerEmail, role: "admin", createdAt: now }),
  ]);
  await writeAudit(env, { actorType: actor.actorType, actorId: actor.actorId, action: "collection.create", resourceType: "collection", resourceId: id, collectionIds: [id] });
  return { id, name: input.name, description: input.description, role: "admin", noteCount: 0, updatedAt: now };
}

export async function updateCollection(
  env: Env,
  principal: KnowledgePrincipal,
  collectionId: string,
  expectedUpdatedAt: string,
  input: { name: string; description: string },
): Promise<CollectionSummary> {
  await requireKnowledgeRole(env, principal, collectionId, "admin");
  const currentTime = nowIso();
  const now = currentTime > expectedUpdatedAt
    ? currentTime
    : new Date(new Date(expectedUpdatedAt).getTime() + 1).toISOString();
  const result = await env.DB.prepare(`
    UPDATE collections SET name = ?, description = ?, updated_at = ?
    WHERE id = ? AND updated_at = ? AND trashed_at IS NULL
  `).bind(input.name, input.description, now, collectionId, expectedUpdatedAt).run();
  if (Number(result.meta.changes) !== 1) {
    throw new ApiError(409, "collection_version_conflict", "知识库已被其他操作更新，请重新读取后再修改");
  }
  const actor = principalActor(principal);
  await writeAudit(env, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "collection.update",
    resourceType: "collection",
    resourceId: collectionId,
    collectionIds: [collectionId],
    metadata: { expectedUpdatedAt, name: input.name },
  });
  const row = await env.DB.prepare(`
    SELECT c.id, c.name, c.description, c.updated_at AS updatedAt,
           sum(case when n.status != 'deleted' then 1 else 0 end) AS noteCount
    FROM collections c LEFT JOIN notes n ON n.collection_id = c.id
    WHERE c.id = ? AND c.trashed_at IS NULL GROUP BY c.id
  `).bind(collectionId).first<{ id: string; name: string; description: string; updatedAt: string; noteCount: number }>();
  if (!row) throw new ApiError(404, "collection_not_found", "知识库不存在或无权访问");
  return { ...row, noteCount: Number(row.noteCount), role: "admin" };
}

export async function trashCollection(
  env: Env,
  principal: KnowledgePrincipal,
  collectionId: string,
  input: { expectedUpdatedAt: string; confirmationName: string; reason?: string },
) {
  await requireKnowledgeRole(env, principal, collectionId, "admin");
  const collection = await env.DB.prepare(
    "SELECT id, name, updated_at AS updatedAt FROM collections WHERE id = ? AND trashed_at IS NULL LIMIT 1",
  ).bind(collectionId).first<{ id: string; name: string; updatedAt: string }>();
  if (!collection) throw new ApiError(404, "collection_not_found", "知识库不存在或无权访问");
  if (input.confirmationName !== collection.name) {
    throw new ApiError(409, "collection_confirmation_mismatch", "移入回收站必须提供完全一致的知识库名称");
  }
  if (input.expectedUpdatedAt !== collection.updatedAt) {
    throw new ApiError(409, "collection_version_conflict", "知识库已被其他操作更新，请重新读取后再移入回收站");
  }

  const trashedAt = nowIso();
  const purgeAfter = new Date(new Date(trashedAt).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const actor = principalActor(principal);
  const result = await env.DB.prepare(`
    UPDATE collections
    SET trashed_at = ?, trashed_by = ?, trash_reason = ?, purge_after = ?, updated_at = ?
    WHERE id = ? AND updated_at = ? AND trashed_at IS NULL
  `).bind(
    trashedAt,
    actor.authorId,
    input.reason?.trim() ?? "",
    purgeAfter,
    trashedAt,
    collectionId,
    input.expectedUpdatedAt,
  ).run();
  if (Number(result.meta.changes) !== 1) {
    throw new ApiError(409, "collection_version_conflict", "知识库在移入回收站前已被其他操作更新");
  }
  await writeAudit(env, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "collection.trash",
    resourceType: "collection",
    resourceId: collectionId,
    collectionIds: [collectionId],
    metadata: { expectedUpdatedAt: input.expectedUpdatedAt, trashedAt, purgeAfter, reason: input.reason?.trim() ?? "" },
  });
  return { trashed: true, collectionId, trashedAt, purgeAfter };
}

/** Compatibility alias: collection deletion is now always recoverable. */
export const deleteCollection = trashCollection;

export async function restoreCollection(
  env: Env,
  principal: KnowledgePrincipal,
  collectionId: string,
  expectedTrashedAt: string,
) {
  await requireTrashedKnowledgeRole(env, principal, collectionId, "admin");
  const restoredAt = nowIso();
  const actor = principalActor(principal);
  const result = await env.DB.prepare(`
    UPDATE collections
    SET trashed_at = NULL, trashed_by = NULL, trash_reason = NULL, purge_after = NULL, updated_at = ?
    WHERE id = ? AND trashed_at = ?
  `).bind(restoredAt, collectionId, expectedTrashedAt).run();
  if (Number(result.meta.changes) !== 1) {
    throw new ApiError(409, "collection_restore_conflict", "知识库回收状态已变化，请刷新回收站后重试");
  }
  await writeAudit(env, {
    actorType: actor.actorType,
    actorId: actor.actorId,
    action: "collection.restore",
    resourceType: "collection",
    resourceId: collectionId,
    collectionIds: [collectionId],
    metadata: { expectedTrashedAt, restoredAt },
  });
  return { restored: true, collectionId, restoredAt };
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
