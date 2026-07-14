import type { AdminPrincipal, Env } from "@worker/env";

import { ApiError } from "../lib/errors";
import { parseJson } from "../lib/utils";
import { listCollections } from "./collections";

interface AuditRow {
  id: string;
  actorType: "user" | "token" | "system";
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  collectionIdsJson: string;
  metadataJson: string;
  createdAt: string;
}

function toPublicAudit(row: AuditRow) {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    collectionIds: parseJson<string[]>(row.collectionIdsJson, []),
    metadata: parseJson<Record<string, unknown>>(row.metadataJson, {}),
    createdAt: row.createdAt,
  };
}

export async function listAuditLogs(
  env: Env,
  principal: AdminPrincipal,
  options: { collectionId?: string; limit?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const select = `
    SELECT id, actor_type AS actorType, actor_id AS actorId, action,
           resource_type AS resourceType, resource_id AS resourceId,
           collection_ids_json AS collectionIdsJson, metadata_json AS metadataJson,
           created_at AS createdAt
    FROM audit_logs a
  `;

  if (principal.bootstrapAdmin) {
    const statement = options.collectionId
      ? env.DB.prepare(`${select} WHERE EXISTS (SELECT 1 FROM json_each(a.collection_ids_json) scope WHERE scope.value = ?) ORDER BY a.created_at DESC LIMIT ?`)
          .bind(options.collectionId, limit)
      : env.DB.prepare(`${select} ORDER BY a.created_at DESC LIMIT ?`).bind(limit);
    const result = await statement.all<AuditRow>();
    return (result.results ?? []).map(toPublicAudit);
  }

  const adminIds = (await listCollections(env, principal))
    .filter((collection) => collection.role === "admin")
    .map((collection) => collection.id);
  if (options.collectionId) {
    if (!adminIds.includes(options.collectionId)) {
      throw new ApiError(404, "collection_not_found", "知识库不存在或无权访问");
    }
    adminIds.splice(0, adminIds.length, options.collectionId);
  }
  if (adminIds.length === 0) return [];

  const placeholders = adminIds.map(() => "?").join(",");
  const result = await env.DB.prepare(`
    ${select}
    WHERE EXISTS (
      SELECT 1 FROM json_each(a.collection_ids_json) scope
      WHERE scope.value IN (${placeholders})
    )
    ORDER BY a.created_at DESC LIMIT ?
  `).bind(...adminIds, limit).all<AuditRow>();
  return (result.results ?? []).map(toPublicAudit);
}
