import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env, IndexQueueMessage } from "@worker/env";
import { processIndexMessage } from "@worker/services/indexer";

import { apiRequest, createCollection, createNote, jsonInit, mcpRequest, queueSendResponse, workerFetch } from "./helpers";

interface JsonRpcResponse {
  result?: {
    serverInfo?: { name: string };
    tools?: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>;
    content?: Array<{ type: string; text?: string; uri?: string }>;
    structuredContent?: { result: unknown };
    isError?: boolean;
    contents?: Array<{ uri: string; text: string }>;
  };
  error?: { code: number; message: string };
}

afterEach(() => vi.restoreAllMocks());

async function createToken(collectionIds: string[], scopes = ["knowledge:read"]) {
  const created = await apiRequest<{ id: string; token: string }>(
    "/api/v1/tokens",
    jsonInit("POST", { name: "Codex test", collectionIds, scopes, expiresAt: null }),
  );
  if (!created.response.ok || !("data" in created.body)) throw new Error("Token creation failed");
  return created.body.data;
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await mcpRequest(token, method, params, id);
  return { response, body: await response.json() as JsonRpcResponse };
}

describe("stateless MCP contract", () => {
  it("initializes, discovers all tools, filters lists and reads cited Markdown resources", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    vi.spyOn(env.VECTOR_INDEX, "upsert").mockResolvedValue({ ids: [], count: 0 });
    vi.spyOn(env.VECTOR_INDEX, "query").mockResolvedValue({ count: 0, matches: [] });
    const collection = await createCollection("MCP collection");
    const created = await createNote(collection.id, { title: "MCP 权限", tags: ["MCP", "安全"], body: "授权正文 marker-42" });
    await processIndexMessage(env as Env, sent[0]);
    const token = await createToken([collection.id]);

    const stored = await env.DB.prepare("SELECT token_hash AS hash, token_prefix AS prefix FROM api_tokens WHERE id = ?")
      .bind(token.id)
      .first<{ hash: string; prefix: string }>();
    expect(stored?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.hash).not.toContain(token.token);
    expect(token.token.startsWith(stored?.prefix ?? "missing")).toBe(true);

    const initialized = await rpc(token.token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "1.0.0" },
    });
    expect(initialized.response.status).toBe(200);
    expect(initialized.body.result?.serverInfo?.name).toBe("knowledge-core");

    const tools = await rpc(token.token, "tools/list", {}, 2);
    const names = tools.body.result?.tools?.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "search_knowledge",
      "read_note",
      "list_notes",
      "list_collections",
      "list_recent_changes",
      "propose_memory",
    ]));
    expect(names).toHaveLength(6);
    const listNotesSchema = tools.body.result?.tools?.find((tool) => tool.name === "list_notes")?.inputSchema?.properties;
    expect(listNotesSchema).toMatchObject({ tags: expect.any(Object), updated_after: expect.any(Object) });

    const collections = await rpc(token.token, "tools/call", { name: "list_collections", arguments: {} }, 3);
    expect(collections.body.result?.structuredContent?.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: collection.id, name: "MCP collection" }),
    ]));

    const listed = await rpc(token.token, "tools/call", {
      name: "list_notes",
      arguments: { collection_ids: [collection.id], tags: ["安全"], limit: 10 },
    }, 4);
    expect(listed.body.result?.structuredContent?.result).toEqual([
      expect.objectContaining({ id: created.note.id, title: "MCP 权限" }),
    ]);

    const future = await rpc(token.token, "tools/call", {
      name: "list_notes",
      arguments: { updated_after: "2999-01-01T00:00:00.000Z" },
    }, 5);
    expect(future.body.result?.structuredContent?.result).toEqual([]);

    const note = await rpc(token.token, "tools/call", { name: "read_note", arguments: { note_id: created.note.id } }, 6);
    expect(JSON.stringify(note.body.result?.structuredContent?.result)).toContain("marker-42");

    const uri = `kb://collections/${collection.id}/notes/${created.note.id}`;
    const resource = await rpc(token.token, "resources/read", { uri }, 7);
    expect(resource.body.result?.contents?.[0]).toMatchObject({ uri, text: expect.stringContaining("marker-42") });

    const searched = await rpc(token.token, "tools/call", {
      name: "search_knowledge",
      arguments: { query: "marker-42", collection_ids: [collection.id], limit: 8 },
    }, 8);
    expect(searched.body.result?.structuredContent?.result).toEqual(expect.arrayContaining([
      expect.objectContaining({ noteId: created.note.id, resourceUri: uri }),
    ]));
  });

  it("rejects missing credentials, invalid tool parameters and missing scopes", async () => {
    const unauthenticated = await workerFetch("/mcp", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(unauthenticated.status).toBe(401);

    const malformedToken = await mcpRequest("kcore_too-short", "tools/list", {}, 2);
    expect(malformedToken.status).toBe(401);

    const collection = await createCollection("MCP validation");
    const token = await createToken([collection.id], ["knowledge:read"]);
    const invalid = await rpc(token.token, "tools/call", {
      name: "search_knowledge",
      arguments: { query: "test", collection_ids: [collection.id], limit: 9 },
    }, 2);
    expect(invalid.body.result?.isError ?? Boolean(invalid.body.error)).toBe(true);

    const forbidden = await rpc(token.token, "tools/call", {
      name: "propose_memory",
      arguments: { collection_id: collection.id, title: "Denied", body: "must not persist" },
    }, 3);
    expect(forbidden.body.result?.isError ?? Boolean(forbidden.body.error)).toBe(true);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM memory_proposals WHERE collection_id = ?").bind(collection.id).first<{ count: number }>())?.count).toBe(0);
  });

  it("does not expose another collection and rejects expired credentials", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const allowed = await createCollection("Allowed");
    const forbidden = await createCollection("Forbidden");
    const secret = await createNote(forbidden.id, { title: "Private", body: "DO-NOT-LEAK-773" });
    const token = await createToken([allowed.id]);

    const read = await rpc(token.token, "tools/call", { name: "read_note", arguments: { note_id: secret.note.id } });
    expect(read.body.result?.isError ?? Boolean(read.body.error)).toBe(true);
    expect(JSON.stringify(read.body)).not.toContain("DO-NOT-LEAK-773");

    const resource = await rpc(
      token.token,
      "resources/read",
      { uri: `kb://collections/${forbidden.id}/notes/${secret.note.id}` },
      2,
    );
    expect(resource.body.error).toBeDefined();
    expect(JSON.stringify(resource.body)).not.toContain("DO-NOT-LEAK-773");

    const search = await rpc(token.token, "tools/call", {
      name: "search_knowledge",
      arguments: { query: "DO-NOT-LEAK-773", collection_ids: [forbidden.id], limit: 8 },
    }, 3);
    expect(search.body.result?.isError ?? Boolean(search.body.error)).toBe(true);
    expect(JSON.stringify(search.body)).not.toContain("DO-NOT-LEAK-773");

    await apiRequest(`/api/v1/tokens/${token.id}`, { method: "DELETE" });
    const revoked = await mcpRequest(token.token, "tools/list", {}, 4);
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain(token.token);

    const expiringToken = await createToken([allowed.id]);
    await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", expiringToken.id)
      .run();
    const expired = await mcpRequest(expiringToken.token, "tools/list", {}, 5);
    expect(expired.status).toBe(401);
    expect(await expired.text()).not.toContain(expiringToken.token);
  });

  it("keeps proposed memory outside formal search until an administrator approves it", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    vi.spyOn(env.VECTOR_INDEX, "query").mockResolvedValue({ count: 0, matches: [] });
    const collection = await createCollection("Memory review");
    const token = await createToken([collection.id], ["knowledge:read", "memory:propose"]);

    const proposed = await rpc(token.token, "tools/call", {
      name: "propose_memory",
      arguments: {
        collection_id: collection.id,
        title: "Agent observation",
        body: "PENDING-MEMORY-991 must not be searchable yet.",
        tags: ["agent"],
        source: "codex:test",
      },
    });
    const proposal = proposed.body.result?.structuredContent?.result as { id: string; status: string };
    expect(proposal.status).toBe("pending");
    expect(await env.NOTES.get(`proposals/${collection.id}/${proposal.id}.md`)).not.toBeNull();
    expect((await env.DB.prepare("SELECT count(*) AS count FROM chunks WHERE collection_id = ?").bind(collection.id).first<{ count: number }>())?.count).toBe(0);

    const search = await rpc(token.token, "tools/call", {
      name: "search_knowledge",
      arguments: { query: "PENDING-MEMORY-991", collection_ids: [collection.id] },
    }, 2);
    expect(search.body.result?.structuredContent?.result).toEqual([]);

    const reviewed = await apiRequest<{ approvedNoteId: string; status: string }>(
      `/api/v1/proposals/${proposal.id}/review`,
      jsonInit("POST", { decision: "approved", reviewNote: "verified" }),
    );
    expect(reviewed.response.status).toBe(200);
    expect("data" in reviewed.body && reviewed.body.data.status).toBe("approved");
    const approvedNoteId = "data" in reviewed.body ? reviewed.body.data.approvedNoteId : "";
    const approved = await env.DB.prepare("SELECT status, title FROM notes WHERE id = ?").bind(approvedNoteId).first<{ status: string; title: string }>();
    expect(approved).toEqual({ status: "published", title: "Agent observation" });
    expect(sent.some((message) => message.type === "index" && message.noteId === approvedNoteId)).toBe(true);
  });

  it("allows only one concurrent approval to create formal knowledge", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Concurrent review");
    const token = await createToken([collection.id], ["memory:propose"]);
    const proposed = await rpc(token.token, "tools/call", {
      name: "propose_memory",
      arguments: { collection_id: collection.id, title: "Single promotion", body: "Only one note", tags: [] },
    });
    const proposal = proposed.body.result?.structuredContent?.result as { id: string };

    const [first, second] = await Promise.all([
      apiRequest(`/api/v1/proposals/${proposal.id}/review`, jsonInit("POST", { decision: "approved", reviewNote: "first" })),
      apiRequest(`/api/v1/proposals/${proposal.id}/review`, jsonInit("POST", { decision: "approved", reviewNote: "second" })),
    ]);
    expect([first.response.status, second.response.status].sort()).toEqual([200, 409]);
    const count = await env.DB.prepare("SELECT count(*) AS count FROM notes WHERE collection_id = ? AND title = ?")
      .bind(collection.id, "Single promotion")
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });
});
