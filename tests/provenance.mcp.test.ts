import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env, IndexQueueMessage } from "@worker/env";
import { processIndexMessage } from "@worker/services/indexer";

import { apiRequest, createCollection, jsonInit, mcpRequest, queueSendResponse } from "./helpers";

afterEach(() => vi.restoreAllMocks());

interface JsonRpcResponse {
  result?: {
    tools?: Array<{ name: string }>;
    structuredContent?: { result: unknown };
    isError?: boolean;
    contents?: Array<{ uri: string; text: string }>;
  };
  error?: { code: number; message: string };
}

async function createToken(collectionId: string) {
  const created = await apiRequest<{ id: string; token: string }>(
    "/api/v1/tokens",
    jsonInit("POST", {
      name: "Freshness reader",
      collectionIds: [collectionId],
      scopes: ["knowledge:read"],
      expiresAt: null,
    }),
  );
  if (!created.response.ok || !("data" in created.body)) throw new Error("Token creation failed");
  return created.body.data;
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await mcpRequest(token, method, params, id);
  return { response, body: await response.json() as JsonRpcResponse };
}

describe("MCP provenance and freshness", () => {
  it("returns provenance and review_due warnings from every knowledge read path", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    vi.spyOn(env.VECTOR_INDEX, "upsert").mockResolvedValue({ ids: [], count: 0 });
    vi.spyOn(env.VECTOR_INDEX, "query").mockResolvedValue({ count: 0, matches: [] });

    const collection = await createCollection("Freshness MCP");
    const markdown = [
      "---",
      "title: MCP stale source",
      "tags: [freshness]",
      "status: published",
      "source:",
      "  type: url",
      "  uri: https://example.com/freshness",
      "  label: Freshness source",
      "  observed_at: 2026-08-01T00:00:00.000Z",
      "review_after: 2000-01-01T00:00:00.000Z",
      "---",
      "",
      "# MCP stale source",
      "",
      "FRESHNESS-MARKER-733",
      "",
    ].join("\n");
    const created = await apiRequest<{ id: string }>(
      `/api/v1/collections/${collection.id}/notes`,
      jsonInit("POST", { markdown }),
    );
    if (!("data" in created.body)) throw new Error("Note creation failed");
    await processIndexMessage(env as Env, sent[0]);

    const token = await createToken(collection.id);
    const tools = await rpc(token.token, "tools/list");
    expect(tools.body.result?.tools?.map((tool) => tool.name)).toContain("list_review_due");

    const listed = await rpc(token.token, "tools/call", {
      name: "list_notes",
      arguments: { collection_ids: [collection.id] },
    }, 2);
    expect(listed.body.result?.structuredContent?.result).toEqual([
      expect.objectContaining({
        id: created.body.data.id,
        source: expect.objectContaining({ uri: "https://example.com/freshness" }),
        warnings: ["review_due"],
      }),
    ]);

    const read = await rpc(token.token, "tools/call", {
      name: "read_note",
      arguments: { note_id: created.body.data.id },
    }, 3);
    expect(read.body.result?.structuredContent?.result).toMatchObject({
      id: created.body.data.id,
      observedAt: "2026-08-01T00:00:00.000Z",
      reviewAfter: "2000-01-01T00:00:00.000Z",
      warnings: ["review_due"],
    });

    const searched = await rpc(token.token, "tools/call", {
      name: "search_knowledge",
      arguments: { query: "FRESHNESS-MARKER-733", collection_ids: [collection.id], limit: 8 },
    }, 4);
    expect(searched.body.result?.structuredContent?.result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        noteId: created.body.data.id,
        source: expect.objectContaining({ type: "url" }),
        warnings: ["review_due"],
      }),
    ]));

    const due = await rpc(token.token, "tools/call", { name: "list_review_due", arguments: {} }, 5);
    expect(due.body.result?.structuredContent?.result).toEqual([
      expect.objectContaining({ id: created.body.data.id, warnings: ["review_due"] }),
    ]);

    const uri = `kb://collections/${collection.id}/notes/${created.body.data.id}`;
    const resource = await rpc(token.token, "resources/read", { uri }, 6);
    expect(resource.body.result?.contents?.[0]?.text).toContain("Knowledge Core: review_due");
    expect(resource.body.result?.contents?.[0]?.text).toContain("FRESHNESS-MARKER-733");
  });
});
