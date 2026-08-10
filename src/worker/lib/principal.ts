import type { Role } from "@shared/contracts";
import type { Env, KnowledgePrincipal, McpPrincipal } from "@worker/env";

import { requireCollectionRole } from "./auth";
import { ApiError } from "./errors";

export function isMcpPrincipal(principal: KnowledgePrincipal): principal is McpPrincipal {
  return "tokenId" in principal;
}

export function isKnowledgeAdmin(principal: McpPrincipal): boolean {
  return principal.scopes.includes("knowledge:admin");
}

export function principalActor(principal: KnowledgePrincipal) {
  return isMcpPrincipal(principal)
    ? { actorType: "token" as const, actorId: principal.tokenId, authorId: `mcp:${principal.tokenId}` }
    : { actorType: "user" as const, actorId: principal.email, authorId: principal.email };
}

export async function requireKnowledgeRole(
  env: Env,
  principal: KnowledgePrincipal,
  collectionId: string,
  role: Role,
): Promise<void> {
  if (!isMcpPrincipal(principal)) {
    await requireCollectionRole(env, principal, collectionId, role);
    return;
  }

  if (!isKnowledgeAdmin(principal)) {
    throw new ApiError(403, "scope_required", "Token 缺少 knowledge:admin 权限");
  }
  const collection = await env.DB.prepare("SELECT id FROM collections WHERE id = ? LIMIT 1")
    .bind(collectionId)
    .first<{ id: string }>();
  if (!collection) throw new ApiError(404, "collection_not_found", "知识库不存在或无权访问");
}
