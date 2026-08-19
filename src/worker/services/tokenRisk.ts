import type { McpPrincipal, Env } from "@worker/env";

import { writeAudit } from "../lib/audit";
import { ApiError } from "../lib/errors";
import { sha256 } from "../lib/crypto";
import { nowIso } from "../lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECEIPT_TTL_MS = 7 * DAY_MS;

export type TokenUsageCategory = "read" | "search" | "proposal" | "write";

interface ReceiptClaim {
  replay: boolean;
  result?: unknown;
}

function utcMinute(value: string): string {
  return `${value.slice(0, 16)}:00.000Z`;
}

function utcHour(value: string): string {
  return `${value.slice(0, 13)}:00:00.000Z`;
}

function utcDate(value: string): string {
  return value.slice(0, 10);
}

function retryAfterSeconds(window: "minute" | "hour", now = Date.now()): number {
  const unit = window === "minute" ? 60_000 : 60 * 60_000;
  return Math.max(1, Math.ceil((unit - (now % unit)) / 1000));
}

function limitError(window: "minute" | "hour", retry: number): ApiError {
  return new ApiError(
    429,
    window === "minute" ? "token_rate_limited" : "token_write_rate_limited",
    window === "minute" ? "Token 请求频率已达到限额" : "Token 写入频率已达到限额",
    { retryAfterSeconds: retry },
  );
}

function usageUpsert(
  env: Env,
  tokenId: string,
  usageDate: string,
  increments: Partial<Record<"requests" | "reads" | "searches" | "proposals" | "writes" | "failures" | "throttles", number>>,
  lastUsedAt: string,
) {
  const fields = ["requests", "reads", "searches", "proposals", "writes", "failures", "throttles"] as const;
  const values = fields.map((field) => increments[field] ?? 0);
  const updates = fields.map((field) => `${field} = token_usage_daily.${field} + excluded.${field}`).join(", ");
  return env.DB.prepare(`
    INSERT INTO token_usage_daily (
      token_id, usage_date, requests, reads, searches, proposals, writes, failures, throttles, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_id, usage_date) DO UPDATE SET
      ${updates},
      last_used_at = excluded.last_used_at
  `).bind(tokenId, usageDate, ...values, lastUsedAt);
}

async function recordThrottle(env: Env, tokenId: string, now: string, window: "minute" | "hour"): Promise<void> {
  await usageUpsert(env, tokenId, utcDate(now), { throttles: 1 }, now).run();
  await writeAudit(env, {
    actorType: "token",
    actorId: tokenId,
    action: "token.anomaly",
    resourceType: "api_token",
    resourceId: tokenId,
    metadata: { kind: window === "minute" ? "request_rate_limit" : "write_rate_limit" },
  }).catch(() => undefined);
}

export function normalizeIpPrefix(value: string | null | undefined): string | null {
  const candidate = value?.split(",", 1)[0]?.trim() ?? "";
  if (!candidate) return null;
  const ipv4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4 && ipv4.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255)) {
    return `${Number(ipv4[1])}.${Number(ipv4[2])}.${Number(ipv4[3])}.0/24`;
  }
  if (!candidate.includes(":")) return null;
  const expanded = candidate.toLowerCase().split("%")[0];
  const halves = expanded.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const validGroup = (group: string) => /^[0-9a-f]{1,4}$/.test(group);
  if (left.some((group) => !validGroup(group)) || right.some((group) => !validGroup(group))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  return `${groups.slice(0, 4).map((group) => group.padStart(4, "0")).join(":")}:0:0:0:0/64`;
}

export async function consumeAdminRequestBudget(env: Env, principal: McpPrincipal, now = nowIso()): Promise<void> {
  const windowStart = utcMinute(now);
  const row = await env.DB.prepare(`
    INSERT INTO token_rate_windows (token_id, window_kind, window_start, count)
    VALUES (?, 'request_minute', ?, 1)
    ON CONFLICT(token_id, window_kind, window_start) DO UPDATE SET count = count + 1
      WHERE count < ?
    RETURNING count
  `).bind(principal.tokenId, windowStart, principal.maxRequestsPerMinute).first<{ count: number }>();
  if (!row) {
    await recordThrottle(env, principal.tokenId, now, "minute");
    throw limitError("minute", retryAfterSeconds("minute"));
  }
  await env.DB.batch([
    usageUpsert(env, principal.tokenId, utcDate(now), { requests: 1 }, now),
    env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now, principal.tokenId),
  ]);
}

async function consumeAdminWriteBudget(env: Env, principal: McpPrincipal, now: string): Promise<void> {
  const windowStart = utcHour(now);
  const row = await env.DB.prepare(`
    INSERT INTO token_rate_windows (token_id, window_kind, window_start, count)
    VALUES (?, 'write_hour', ?, 1)
    ON CONFLICT(token_id, window_kind, window_start) DO UPDATE SET count = count + 1
      WHERE count < ?
    RETURNING count
  `).bind(principal.tokenId, windowStart, principal.maxWritesPerHour).first<{ count: number }>();
  if (!row) {
    await recordThrottle(env, principal.tokenId, now, "hour");
    throw limitError("hour", retryAfterSeconds("hour"));
  }
}

async function recordIpChange(env: Env, principal: McpPrincipal, now: string): Promise<void> {
  if (!principal.ipPrefix) return;
  const result = await env.DB.prepare(`
    UPDATE api_tokens
    SET last_ip_prefix = ?, last_ip_changed_at = ?
    WHERE id = ? AND (last_ip_prefix IS NULL OR last_ip_prefix != ?)
  `).bind(principal.ipPrefix, now, principal.tokenId, principal.ipPrefix).run();
  if (Number(result.meta.changes) !== 1) return;
  await writeAudit(env, {
    actorType: "token",
    actorId: principal.tokenId,
    action: "token.ip_changed",
    resourceType: "api_token",
    resourceId: principal.tokenId,
    metadata: { ipPrefix: principal.ipPrefix },
  });
}

export async function recordAdminUsage(
  env: Env,
  principal: McpPrincipal,
  category: TokenUsageCategory,
  now = nowIso(),
): Promise<void> {
  const field = category === "read" ? "reads"
    : category === "search" ? "searches"
      : category === "proposal" ? "proposals"
        : "writes";
  await env.DB.batch([
    usageUpsert(env, principal.tokenId, utcDate(now), { [field]: 1 }, now),
    env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now, principal.tokenId),
  ]);
}

export async function recordAdminFailure(env: Env, principal: McpPrincipal, now = nowIso()): Promise<void> {
  await env.DB.batch([
    usageUpsert(env, principal.tokenId, utcDate(now), { failures: 1 }, now),
    env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now, principal.tokenId),
  ]);
}

function safeResult(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(safeResult);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["markdown", "body", "token", "rawToken", "content"].includes(key)) continue;
    output[key] = safeResult(item);
  }
  return output;
}

function parseResult(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function claimMutation(
  env: Env,
  principal: McpPrincipal,
  operationId: string,
  toolName: string,
  input: unknown,
  now = nowIso(),
): Promise<ReceiptClaim> {
  const inputHash = await sha256(JSON.stringify(input));
  const expiresAt = new Date(new Date(now).getTime() + RECEIPT_TTL_MS).toISOString();
  const inserted = await env.DB.prepare(`
    INSERT INTO token_mutation_receipts (
      token_id, operation_id, tool_name, input_hash, status, created_at, expires_at
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(token_id, operation_id) DO NOTHING
  `).bind(principal.tokenId, operationId, toolName, inputHash, now, expiresAt).run();
  if (Number(inserted.meta.changes) === 1) return { replay: false };
  const receipt = await env.DB.prepare(`
    SELECT tool_name AS toolName, input_hash AS inputHash, status, result_json AS resultJson
    FROM token_mutation_receipts WHERE token_id = ? AND operation_id = ?
  `).bind(principal.tokenId, operationId).first<{ toolName: string; inputHash: string; status: "pending" | "completed" | "failed"; resultJson: string | null }>();
  if (!receipt) throw new ApiError(503, "mutation_receipt_unavailable", "Token 幂等回执暂时不可用");
  if (receipt.toolName !== toolName || receipt.inputHash !== inputHash) {
    throw new ApiError(409, "operation_id_reused", "operation_id 已用于其他工具或其他输入");
  }
  if (receipt.status === "completed") return { replay: true, result: parseResult(receipt.resultJson) };
  if (receipt.status === "pending") {
    throw new ApiError(409, "operation_in_progress", "相同 operation_id 的写操作仍在处理中，请稍后使用原请求重试");
  }
  const reclaimed = await env.DB.prepare(`
    UPDATE token_mutation_receipts
    SET status = 'pending', result_json = NULL, error_code = NULL, failed_at = NULL,
        created_at = ?, expires_at = ?
    WHERE token_id = ? AND operation_id = ? AND status = 'failed'
  `).bind(now, expiresAt, principal.tokenId, operationId).run();
  if (Number(reclaimed.meta.changes) !== 1) {
    throw new ApiError(409, "operation_in_progress", "相同 operation_id 的写操作仍在处理中，请稍后重试");
  }
  return { replay: false };
}

export async function runAdminMutation<T>(
  env: Env,
  principal: McpPrincipal,
  operationId: string,
  toolName: string,
  input: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  const claim = await claimMutation(env, principal, operationId, toolName, input);
  if (claim.replay) return claim.result as T;
  const now = nowIso();
  try {
    await consumeAdminWriteBudget(env, principal, now);
    await recordIpChange(env, principal, now);
  } catch (error) {
    await env.DB.prepare("DELETE FROM token_mutation_receipts WHERE token_id = ? AND operation_id = ? AND status = 'pending'")
      .bind(principal.tokenId, operationId).run();
    throw error;
  }
  try {
    const result = await operation();
    const summary = JSON.stringify(safeResult(result));
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE token_mutation_receipts
        SET status = 'completed', result_json = ?, completed_at = ?
        WHERE token_id = ? AND operation_id = ? AND status = 'pending'
      `).bind(summary, nowIso(), principal.tokenId, operationId),
      usageUpsert(env, principal.tokenId, utcDate(nowIso()), { writes: 1 }, nowIso()),
      env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(nowIso(), principal.tokenId),
    ]);
    return result;
  } catch (error) {
    const errorCode = error instanceof ApiError ? error.code : "internal_error";
    try {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE token_mutation_receipts
          SET status = 'failed', error_code = ?, failed_at = ?
          WHERE token_id = ? AND operation_id = ? AND status = 'pending'
        `).bind(errorCode, nowIso(), principal.tokenId, operationId),
        usageUpsert(env, principal.tokenId, utcDate(nowIso()), { failures: 1 }, nowIso()),
        env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(nowIso(), principal.tokenId),
      ]);
    } catch {
      throw new ApiError(503, "token_usage_unavailable", "Token 用量记录暂时不可用，写操作已失败关闭");
    }
    if (error instanceof ApiError && error.status !== 429) {
      await writeAudit(env, {
        actorType: "token",
        actorId: principal.tokenId,
        action: "token.anomaly",
        resourceType: "api_token",
        resourceId: principal.tokenId,
        metadata: { kind: "mutation_failure", code: error.code },
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function getTokenUsage(env: Env, tokenId: string, days: number) {
  const token = await env.DB.prepare(`
    SELECT id, name, token_prefix AS prefix, expires_at AS expiresAt, revoked_at AS revokedAt,
           max_requests_per_minute AS maxRequestsPerMinute, max_writes_per_hour AS maxWritesPerHour,
           last_ip_prefix AS lastIpPrefix, last_ip_changed_at AS lastIpChangedAt
    FROM api_tokens WHERE id = ? LIMIT 1
  `).bind(tokenId).first();
  if (!token) throw new ApiError(404, "token_not_found", "Token 不存在");
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
  const usage = await env.DB.prepare(`
    SELECT usage_date AS usageDate, requests, reads, searches, proposals, writes, failures, throttles, last_used_at AS lastUsedAt
    FROM token_usage_daily WHERE token_id = ? AND usage_date >= ? ORDER BY usage_date DESC
  `).bind(tokenId, since).all();
  const anomalies = await env.DB.prepare(`
    SELECT action, metadata_json AS metadataJson, created_at AS createdAt
    FROM audit_logs WHERE actor_type = 'token' AND actor_id = ?
      AND action IN ('token.ip_changed', 'token.anomaly')
    ORDER BY created_at DESC LIMIT 50
  `).bind(tokenId).all();
  return { token, days, usage: usage.results ?? [], anomalies: anomalies.results ?? [] };
}

export async function revokeAllKnowledgeAdminTokens(env: Env, actorId: string): Promise<number> {
  const now = nowIso();
  const result = await env.DB.prepare(`
    UPDATE api_tokens SET revoked_at = ?
    WHERE revoked_at IS NULL AND EXISTS (
      SELECT 1 FROM json_each(api_tokens.scopes_json) WHERE json_each.value = 'knowledge:admin'
    )
  `).bind(now).run();
  const count = Number(result.meta.changes);
  await writeAudit(env, {
    actorType: "user",
    actorId,
    action: "token.revoke_all",
    resourceType: "api_token",
    resourceId: "knowledge-admin",
    metadata: { revokedCount: count },
  });
  return count;
}

export async function cleanupTokenRiskData(env: Env): Promise<void> {
  const now = new Date();
  const rateCutoff = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
  const receiptCutoff = now.toISOString();
  const usageCutoff = new Date(now.getTime() - 31 * DAY_MS).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM token_rate_windows WHERE window_start < ?").bind(rateCutoff),
    env.DB.prepare("DELETE FROM token_mutation_receipts WHERE expires_at < ?").bind(receiptCutoff),
    env.DB.prepare("DELETE FROM token_usage_daily WHERE usage_date < ?").bind(usageCutoff),
  ]);
}
