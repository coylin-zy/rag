import { desc, eq } from "drizzle-orm";

import type { TokenScope } from "@shared/contracts";
import type { AdminPrincipal, Env } from "@worker/env";

import { createDb } from "../db/client";
import { apiTokens } from "../db/schema";
import { requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { generateToken, sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { nowIso, parseJson } from "../lib/utils";

function publicToken(row: typeof apiTokens.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.tokenPrefix,
    collectionIds: parseJson<string[]>(row.collectionIdsJson, []),
    scopes: parseJson<string[]>(row.scopesJson, []),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export async function listTokens(env: Env, principal: AdminPrincipal) {
  const db = createDb(env.DB);
  const rows = await db.select().from(apiTokens).orderBy(desc(apiTokens.createdAt)).limit(200);
  if (principal.bootstrapAdmin) return rows.map(publicToken);

  const visible = [];
  for (const row of rows) {
    const collectionIds = parseJson<string[]>(row.collectionIdsJson, []);
    const authorized = await Promise.all(collectionIds.map(async (id) => {
      try {
        await requireCollectionRole(env, principal, id, "admin");
        return true;
      } catch {
        return false;
      }
    }));
    if (authorized.length > 0 && authorized.every(Boolean)) visible.push(publicToken(row));
  }
  return visible;
}

export async function createToken(
  env: Env,
  principal: AdminPrincipal,
  input: {
    name: string;
    collectionIds: string[];
    scopes: TokenScope[];
    expiresAt: string | null;
  },
) {
  const globalAdmin = input.scopes.includes("knowledge:admin");
  if (globalAdmin && !principal.bootstrapAdmin) {
    throw new ApiError(403, "bootstrap_admin_required", "只有初始管理员可以创建最高权限 Agent Token");
  }
  const collectionIds = globalAdmin ? [] : input.collectionIds;
  await Promise.all(collectionIds.map((id) => requireCollectionRole(env, principal, id, "admin")));
  const db = createDb(env.DB);
  const id = crypto.randomUUID();
  const rawToken = generateToken();
  const prefix = rawToken.slice(0, 14);
  const now = nowIso();
  await db.insert(apiTokens).values({
    id,
    name: input.name,
    tokenHash: await sha256(rawToken),
    tokenPrefix: prefix,
    collectionIdsJson: JSON.stringify(collectionIds),
    scopesJson: JSON.stringify(input.scopes),
    createdAt: now,
    createdBy: principal.email,
    expiresAt: input.expiresAt,
  });
  await writeAudit(env, { actorType: "user", actorId: principal.email, action: "token.create", resourceType: "api_token", resourceId: id, collectionIds, metadata: { scopes: input.scopes, globalAdmin } });
  return { id, name: input.name, token: rawToken, prefix, collectionIds, scopes: input.scopes, createdAt: now, expiresAt: input.expiresAt };
}

export async function revokeToken(env: Env, principal: AdminPrincipal, tokenId: string): Promise<void> {
  const db = createDb(env.DB);
  const token = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenId) });
  if (!token) return;
  const collectionIds = parseJson<string[]>(token.collectionIdsJson, []);
  const scopes = parseJson<TokenScope[]>(token.scopesJson, []);
  if (scopes.includes("knowledge:admin") && !principal.bootstrapAdmin) {
    throw new ApiError(403, "bootstrap_admin_required", "只有初始管理员可以撤销最高权限 Agent Token");
  }
  await Promise.all(collectionIds.map((id) => requireCollectionRole(env, principal, id, "admin")));
  await db.update(apiTokens).set({ revokedAt: nowIso() }).where(eq(apiTokens.id, tokenId));
  await writeAudit(env, { actorType: "user", actorId: principal.email, action: "token.revoke", resourceType: "api_token", resourceId: tokenId, collectionIds });
}
