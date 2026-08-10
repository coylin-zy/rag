import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { Role } from "@shared/contracts";
import type { AdminPrincipal, AppVariables, Env, McpPrincipal } from "@worker/env";

import { createDb } from "../db/client";
import { apiTokens } from "../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { sha256 } from "./crypto";
import { ApiError } from "./errors";
import { normalizeEmail, nowIso, parseJson } from "./utils";

const jwksByDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const roleRank: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const ADMIN_SESSION_COOKIE = "knowledge_session";
export const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;

interface AdminSessionPayload {
  version: 1;
  email: string;
  issuedAt: number;
  expiresAt: number;
}

function bootstrapEmails(env: Env): Set<string> {
  return new Set(env.BOOTSTRAP_ADMIN_EMAILS.split(",").map(normalizeEmail).filter(Boolean));
}

function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ApiError(401, "invalid_session", "管理会话无效或已过期");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new ApiError(401, "invalid_session", "管理会话无效或已过期");
  }
}

async function importHmacKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

function ownedBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

async function secureEqual(actual: string, expected: string): Promise<boolean> {
  if (!actual || !expected) return false;
  const message = encoder.encode("knowledge-core-credential-check");
  const expectedKey = await importHmacKey(expected, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", expectedKey, message);
  const actualKey = await importHmacKey(actual, ["verify"]);
  return crypto.subtle.verify("HMAC", actualKey, signature, message);
}

async function signSession(secret: string, payload: Uint8Array): Promise<Uint8Array> {
  const key = await importHmacKey(secret, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, ownedBuffer(payload)));
}

async function verifySessionSignature(secret: string, payload: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await importHmacKey(secret, ["verify"]);
  return crypto.subtle.verify("HMAC", key, ownedBuffer(signature), ownedBuffer(payload));
}

function loginEmail(env: Env): string {
  return normalizeEmail(env.ADMIN_LOGIN_EMAIL);
}

export async function verifyLoginCredentials(env: Env, presentedEmail: string, presentedPassword: string): Promise<AdminPrincipal> {
  const email = normalizeEmail(presentedEmail);
  const configuredEmail = loginEmail(env);
  const passwordHash = await sha256(presentedPassword);
  const passwordMatches = await secureEqual(passwordHash, env.ADMIN_LOGIN_PASSWORD_HASH?.toLowerCase() ?? "");
  if (!configuredEmail || email !== configuredEmail || !passwordMatches) {
    throw new ApiError(401, "invalid_login", "邮箱或密码错误");
  }
  return { email, subject: `session:${email}`, bootstrapAdmin: bootstrapEmails(env).has(email) };
}

export async function createAdminSession(env: Env, email: string, now = Date.now()): Promise<string> {
  if (!env.ADMIN_SESSION_SECRET) throw new ApiError(503, "session_not_configured", "管理会话尚未配置");
  const payload: AdminSessionPayload = {
    version: 1,
    email: normalizeEmail(email),
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + ADMIN_SESSION_TTL_SECONDS,
  };
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await signSession(env.ADMIN_SESSION_SECRET, encoder.encode(encodedPayload));
  return `${encodedPayload}.${encodeBase64Url(signature)}`;
}

export async function verifyAdminSession(env: Env, token: string | undefined, now = Date.now()): Promise<AdminPrincipal> {
  if (!env.ADMIN_SESSION_SECRET) throw new ApiError(503, "session_not_configured", "管理会话尚未配置");
  if (!token) throw new ApiError(401, "session_required", "请先登录管理后台");
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra) throw new ApiError(401, "invalid_session", "管理会话无效或已过期");

  const signature = decodeBase64Url(encodedSignature);
  if (!await verifySessionSignature(env.ADMIN_SESSION_SECRET, encoder.encode(encodedPayload), signature)) {
    throw new ApiError(401, "invalid_session", "管理会话无效或已过期");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(decodeBase64Url(encodedPayload)));
  } catch {
    throw new ApiError(401, "invalid_session", "管理会话无效或已过期");
  }
  if (!payload || typeof payload !== "object") throw new ApiError(401, "invalid_session", "管理会话无效或已过期");
  const candidate = payload as Partial<AdminSessionPayload>;
  const email = typeof candidate.email === "string" ? normalizeEmail(candidate.email) : "";
  const nowSeconds = Math.floor(now / 1000);
  if (
    candidate.version !== 1
    || email !== loginEmail(env)
    || typeof candidate.issuedAt !== "number"
    || typeof candidate.expiresAt !== "number"
    || candidate.issuedAt > nowSeconds + 60
    || candidate.expiresAt <= nowSeconds
  ) {
    throw new ApiError(401, "invalid_session", "管理会话无效或已过期");
  }
  return { email, subject: `session:${email}`, bootstrapAdmin: bootstrapEmails(env).has(email) };
}

export async function verifyProxyAdmin(env: Env, presentedSecret: string, presentedEmail: string): Promise<AdminPrincipal> {
  if (!env.ADMIN_PROXY_SECRET) throw new ApiError(503, "proxy_auth_not_configured", "管理代理认证尚未配置");
  if (!await secureEqual(presentedSecret, env.ADMIN_PROXY_SECRET)) {
    throw new ApiError(401, "invalid_proxy_identity", "管理代理身份凭证无效");
  }

  const email = normalizeEmail(presentedEmail);
  if (!email) throw new ApiError(401, "invalid_proxy_identity", "管理代理身份中缺少邮箱");
  return { email, subject: `proxy:${email}`, bootstrapAdmin: bootstrapEmails(env).has(email) };
}

async function verifyAccess(env: Env, assertion: string): Promise<AdminPrincipal> {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    throw new ApiError(503, "access_not_configured", "Cloudflare Access 尚未配置");
  }

  const domain = env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  let jwks = jwksByDomain.get(domain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
    jwksByDomain.set(domain, jwks);
  }

  try {
    const { payload } = await jwtVerify(assertion, jwks, {
      audience: env.CF_ACCESS_AUD,
      issuer: `https://${domain}`,
    });
    const email = typeof payload.email === "string" ? normalizeEmail(payload.email) : "";
    if (!email || !payload.sub) throw new ApiError(401, "invalid_access_identity", "Access 身份中缺少邮箱或用户 ID");
    return { email, subject: payload.sub, bootstrapAdmin: bootstrapEmails(env).has(email) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "invalid_access_assertion", "Cloudflare Access 身份凭证无效或已过期");
  }
}

export function adminAuth(): MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> {
  return async (c, next) => {
    if (c.env.ENVIRONMENT === "development" && c.env.DEV_AUTH_BYPASS === "true") {
      const email = normalizeEmail(c.req.header("x-dev-user-email") ?? "admin@example.com");
      c.set("principal", { email, subject: `dev:${email}`, bootstrapAdmin: bootstrapEmails(c.env).has(email) });
      await next();
      return;
    }

    const proxySecret = c.req.header("x-knowledge-proxy-secret");
    if (proxySecret) {
      const proxyPrincipal = await verifyProxyAdmin(
        c.env,
        proxySecret,
        c.req.header("x-knowledge-admin-email") ?? "",
      );
      const cookieHeader = c.req.header("cookie") ?? "";
      const sessionToken = cookieHeader
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${ADMIN_SESSION_COOKIE}=`))
        ?.slice(ADMIN_SESSION_COOKIE.length + 1);
      const sessionPrincipal = await verifyAdminSession(c.env, sessionToken);
      if (sessionPrincipal.email !== proxyPrincipal.email) {
        throw new ApiError(401, "invalid_session", "管理会话无效或已过期");
      }
      c.set("principal", sessionPrincipal);
      await next();
      return;
    }

    const assertion = c.req.header("cf-access-jwt-assertion");
    if (!assertion) throw new ApiError(401, "access_required", "需要通过 Cloudflare Access 登录");
    c.set("principal", await verifyAccess(c.env, assertion));
    await next();
  };
}

type CollectionState = "active" | "trashed" | "any";

async function collectionRoleForState(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  state: CollectionState,
): Promise<Role | null> {
  const stateClause = state === "active"
    ? "AND c.trashed_at IS NULL"
    : state === "trashed"
      ? "AND c.trashed_at IS NOT NULL"
      : "";
  if (principal.bootstrapAdmin) {
    const collection = await env.DB.prepare(`SELECT c.id FROM collections c WHERE c.id = ? ${stateClause} LIMIT 1`)
      .bind(collectionId)
      .first<{ id: string }>();
    return collection ? "admin" : null;
  }
  const row = await env.DB.prepare(`
    SELECT m.role
    FROM memberships m
    JOIN collections c ON c.id = m.collection_id
    WHERE m.collection_id = ? AND m.user_email = ? ${stateClause}
    LIMIT 1
  `)
    .bind(collectionId, principal.email)
    .first<{ role: Role }>();
  return row?.role ?? null;
}

export async function collectionRole(env: Env, principal: AdminPrincipal, collectionId: string): Promise<Role | null> {
  return collectionRoleForState(env, principal, collectionId, "active");
}

async function requireRoleForState(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  minimum: Role,
  state: CollectionState,
): Promise<Role> {
  const role = await collectionRoleForState(env, principal, collectionId, state);
  if (!role) throw new ApiError(404, "collection_not_found", "知识库不存在或无权访问");
  if (roleRank[role] < roleRank[minimum]) throw new ApiError(403, "insufficient_role", "当前角色没有执行该操作的权限");
  return role;
}

export async function requireCollectionRole(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  minimum: Role,
): Promise<Role> {
  return requireRoleForState(env, principal, collectionId, minimum, "active");
}

export async function requireTrashedCollectionRole(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  minimum: Role,
): Promise<Role> {
  return requireRoleForState(env, principal, collectionId, minimum, "trashed");
}

export async function requireAnyCollectionRole(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  minimum: Role,
): Promise<Role> {
  return requireRoleForState(env, principal, collectionId, minimum, "any");
}

export async function authenticateMcpToken(env: Env, authorization: string | undefined): Promise<McpPrincipal> {
  if (!authorization?.startsWith("Bearer ")) throw new ApiError(401, "mcp_token_required", "缺少 MCP Bearer Token");
  const rawToken = authorization.slice(7).trim();
  if (!/^kcore_[A-Za-z0-9_-]{43}$/.test(rawToken)) throw new ApiError(401, "invalid_mcp_token", "MCP Token 无效");

  const db = createDb(env.DB);
  const tokenHash = await sha256(rawToken);
  const token = await db.query.apiTokens.findFirst({
    where: and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)),
  });
  if (!token || (token.expiresAt && token.expiresAt <= nowIso())) {
    throw new ApiError(401, "invalid_mcp_token", "MCP Token 无效或已过期");
  }

  await db.update(apiTokens).set({ lastUsedAt: nowIso() }).where(eq(apiTokens.id, token.id));
  return {
    tokenId: token.id,
    name: token.name,
    createdBy: token.createdBy,
    collectionIds: parseJson<string[]>(token.collectionIdsJson, []),
    scopes: parseJson<McpPrincipal["scopes"]>(token.scopesJson, []),
  };
}
