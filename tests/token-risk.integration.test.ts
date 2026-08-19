import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeIpPrefix } from "@worker/services/tokenRisk";
import { apiRequest, jsonInit, queueSendResponse, workerFetch } from "./helpers";

interface RpcBody {
  result?: {
    structuredContent?: { result?: unknown; error?: { code: string; message?: string; details?: unknown } };
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  error?: unknown;
}

async function createAdminToken(options: {
  expiresAt?: string | null;
  maxRequestsPerMinute?: number;
  maxWritesPerHour?: number;
} = {}) {
  const created = await apiRequest<{ id: string; token: string }>(
    "/api/v1/tokens",
    jsonInit("POST", {
      name: `Risk test ${crypto.randomUUID().slice(0, 8)}`,
      collectionIds: [],
      scopes: ["knowledge:admin"],
      expiresAt: options.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      maxRequestsPerMinute: options.maxRequestsPerMinute ?? 60,
      maxWritesPerHour: options.maxWritesPerHour ?? 30,
    }),
  );
  if (!created.response.ok || !("data" in created.body)) throw new Error(`Unable to create admin token: ${created.response.status}`);
  return created.body.data;
}

async function mcpCall(token: string, method: string, params: Record<string, unknown> = {}, id = 1, ip?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (ip) headers["cf-connecting-ip"] = ip;
  const response = await workerFetch("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { response, body: await response.json() as RpcBody };
}

function callTool(token: string, name: string, argumentsValue: Record<string, unknown>, id = 1, ip?: string) {
  return mcpCall(token, "tools/call", { name, arguments: argumentsValue }, id, ip);
}

describe("highest-permission Token risk controls", () => {
  afterEach(() => vi.restoreAllMocks());

  it("normalizes client addresses to privacy-preserving network prefixes", () => {
    expect(normalizeIpPrefix("203.0.113.88")).toBe("203.0.113.0/24");
    expect(normalizeIpPrefix("203.0.113.88, 198.51.100.4")).toBe("203.0.113.0/24");
    expect(normalizeIpPrefix("2001:db8:abcd:1234:5678::1")).toBe("2001:0db8:abcd:1234:0:0:0:0/64");
    expect(normalizeIpPrefix("2001:db8::1")).toBe("2001:0db8:0000:0000:0:0:0:0/64");
    expect(normalizeIpPrefix("not-an-ip")).toBeNull();
  });

  it("requires an expiry window for highest-permission Token creation", async () => {
    const permanent = await apiRequest(
      "/api/v1/tokens",
      jsonInit("POST", { name: "Permanent admin", collectionIds: [], scopes: ["knowledge:admin"], expiresAt: null }),
    );
    expect(permanent.response.status).toBe(422);
    expect("error" in permanent.body && permanent.body.error.code).toBe("admin_token_expiry_required");

    const tooLong = await apiRequest(
      "/api/v1/tokens",
      jsonInit("POST", { name: "Long admin", collectionIds: [], scopes: ["knowledge:admin"], expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString() }),
    );
    expect(tooLong.response.status).toBe(422);
    expect("error" in tooLong.body && tooLong.body.error.code).toBe("admin_token_expiry_invalid");
  });

  it("enforces the request budget and does not turn a throttle into a successful request", async () => {
    const token = await createAdminToken({ maxRequestsPerMinute: 2 });
    expect((await mcpCall(token.token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "risk-test", version: "1" },
    })).response.status).toBe(200);
    expect((await mcpCall(token.token, "tools/list", {}, 2)).response.status).toBe(200);
    const throttled = await mcpCall(token.token, "tools/list", {}, 3);
    expect(throttled.response.status).toBe(429);
    expect(JSON.stringify(throttled.body)).toContain("token_rate_limited");

    const usage = await env.DB.prepare("SELECT requests, throttles FROM token_usage_daily WHERE token_id = ?")
      .bind(token.id)
      .first<{ requests: number; throttles: number }>();
    expect(usage).toMatchObject({ requests: 2, throttles: 1 });
  });

  it("makes mutation operation IDs idempotent and enforces the write budget", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const token = await createAdminToken({ maxWritesPerHour: 1 });
    const operationId = crypto.randomUUID();
    const input = { operation_id: operationId, name: "Idempotent base", description: "first" };
    const first = await callTool(token.token, "create_collection", input, 1, "203.0.113.88");
    const firstResult = first.body.result?.structuredContent?.result as { id: string };
    expect(firstResult.id).toEqual(expect.any(String));

    const replay = await callTool(token.token, "create_collection", input, 2, "203.0.113.88");
    expect(replay.body.result?.structuredContent?.result).toEqual(firstResult);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM collections WHERE id = ?").bind(firstResult.id).first<{ count: number }>())?.count).toBe(1);

    const reused = await callTool(token.token, "create_collection", { ...input, name: "Changed input" }, 3, "203.0.113.88");
    expect(reused.body.result?.structuredContent).toMatchObject({ error: { code: "operation_id_reused" } });

    const throttled = await callTool(token.token, "create_collection", { operation_id: crypto.randomUUID(), name: "Must not persist", description: "throttled" }, 4, "203.0.113.88");
    expect(throttled.body.result?.structuredContent).toMatchObject({ error: { code: "token_write_rate_limited" } });
    expect((await env.DB.prepare("SELECT count(*) AS count FROM collections WHERE name = ?").bind("Must not persist").first<{ count: number }>())?.count).toBe(0);
  });

  it("records network changes, exposes usage, and supports emergency revocation", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const token = await createAdminToken({ maxWritesPerHour: 10 });
    await callTool(token.token, "create_collection", { operation_id: crypto.randomUUID(), name: "IP one", description: "" }, 1, "198.51.100.9");
    await callTool(token.token, "create_collection", { operation_id: crypto.randomUUID(), name: "IP same subnet", description: "" }, 2, "198.51.100.77");
    await callTool(token.token, "create_collection", { operation_id: crypto.randomUUID(), name: "IP changed subnet", description: "" }, 3, "198.51.101.9");

    const ipAudit = await env.DB.prepare("SELECT count(*) AS count FROM audit_logs WHERE actor_type = 'token' AND actor_id = ? AND action = 'token.ip_changed'")
      .bind(token.id)
      .first<{ count: number }>();
    expect(ipAudit?.count).toBe(2);
    expect((await env.DB.prepare("SELECT last_ip_prefix AS prefix FROM api_tokens WHERE id = ?").bind(token.id).first<{ prefix: string }>())?.prefix).toBe("198.51.101.0/24");

    const usage = await apiRequest<{ usage: Array<{ writes: number }>; token: { lastIpPrefix: string } }>(`/api/v1/tokens/${token.id}/usage?days=7`);
    expect(usage.response.status).toBe(200);
    expect("data" in usage.body && usage.body.data.token.lastIpPrefix).toBe("198.51.101.0/24");
    expect("data" in usage.body && usage.body.data.usage[0]?.writes).toBe(3);

    const revoked = await apiRequest<{ revokedCount: number }>("/api/v1/tokens/revoke-knowledge-admin", { method: "POST" });
    expect(revoked.response.status).toBe(200);
    expect("data" in revoked.body && revoked.body.data.revokedCount).toBeGreaterThanOrEqual(1);
    expect((await mcpCall(token.token, "tools/list")).response.status).toBe(401);
  });
});
