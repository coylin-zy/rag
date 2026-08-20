import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRequest, createCollection, createNote, jsonInit, mcpRequest, queueSendResponse } from "./helpers";

afterEach(() => vi.restoreAllMocks());

interface JsonRpcResponse {
  result?: {
    tools?: Array<{ name: string }>;
    structuredContent?: { result: unknown };
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function createToken(collectionIds: string[], scopes: string[]) {
  const expiresAt = scopes.includes("knowledge:admin")
    ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    : null;
  const created = await apiRequest<{ id: string; token: string }>(
    "/api/v1/tokens",
    jsonInit("POST", { name: `Version ${scopes.join("+")}`, collectionIds, scopes, expiresAt }),
  );
  if (!created.response.ok || !("data" in created.body)) throw new Error("Token creation failed");
  return created.body.data;
}

async function rpc(token: string, method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await mcpRequest(token, method, params, id);
  return { response, body: await response.json() as JsonRpcResponse };
}

describe("MCP version history", () => {
  it("exposes read-only history to scoped readers and idempotent rollback to knowledge admins", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());

    const collection = await createCollection("MCP version history");
    const created = await createNote(collection.id, { title: "Historical MCP note", body: "first-history-body" });
    const detail = await apiRequest<{ markdown: string }>(`/api/v1/notes/${created.note.id}`);
    if (!("data" in detail.body)) throw new Error("Missing current note");
    const updated = await apiRequest<{ version: number }>(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("PUT", { markdown: detail.body.data.markdown.replace("first-history-body", "second-history-body") }, { "if-match": '"1"' }),
    );
    expect(updated.response.status).toBe(200);
    expect("data" in updated.body && updated.body.data.version).toBe(2);

    const reader = await createToken([collection.id], ["knowledge:read"]);
    const readerTools = await rpc(reader.token, "tools/list");
    const readerNames = readerTools.body.result?.tools?.map((tool) => tool.name) ?? [];
    expect(readerNames).toEqual(expect.arrayContaining(["list_note_versions", "read_note_version"]));
    expect(readerNames).not.toContain("restore_note_version");

    const listed = await rpc(reader.token, "tools/call", {
      name: "list_note_versions",
      arguments: { note_id: created.note.id },
    }, 2);
    expect(listed.body.result?.structuredContent?.result).toEqual([
      expect.objectContaining({ version: 2 }),
      expect.objectContaining({ version: 1 }),
    ]);

    const first = await rpc(reader.token, "tools/call", {
      name: "read_note_version",
      arguments: { note_id: created.note.id, version: 1 },
    }, 3);
    expect(JSON.stringify(first.body.result?.structuredContent?.result)).toContain("first-history-body");
    expect(JSON.stringify(first.body.result?.structuredContent?.result)).not.toContain("second-history-body");

    const forbiddenCollection = await createCollection("MCP history forbidden");
    const forbiddenNote = await createNote(forbiddenCollection.id, { title: "Other history", body: "HISTORY-SECRET-441" });
    const guessed = await rpc(reader.token, "tools/call", {
      name: "read_note_version",
      arguments: { note_id: forbiddenNote.note.id, version: 1 },
    }, 4);
    expect(guessed.body.result?.isError ?? Boolean(guessed.body.error)).toBe(true);
    expect(JSON.stringify(guessed.body)).not.toContain("HISTORY-SECRET-441");

    const admin = await createToken([], ["knowledge:admin"]);
    const adminTools = await rpc(admin.token, "tools/list", {}, 5);
    expect(adminTools.body.result?.tools?.map((tool) => tool.name)).toContain("restore_note_version");

    const operationId = crypto.randomUUID();
    const restored = await rpc(admin.token, "tools/call", {
      name: "restore_note_version",
      arguments: {
        operation_id: operationId,
        note_id: created.note.id,
        expected_version: 2,
        source_version: 1,
      },
    }, 6);
    expect(restored.body.result?.structuredContent?.result).toMatchObject({
      noteId: created.note.id,
      sourceVersion: 1,
      previousVersion: 2,
      version: 3,
    });

    const replayed = await rpc(admin.token, "tools/call", {
      name: "restore_note_version",
      arguments: {
        operation_id: operationId,
        note_id: created.note.id,
        expected_version: 2,
        source_version: 1,
      },
    }, 7);
    expect(replayed.body.result?.structuredContent?.result).toMatchObject({ version: 3, sourceVersion: 1 });

    const current = await apiRequest<{ version: number; markdown: string }>(`/api/v1/notes/${created.note.id}`);
    expect("data" in current.body && current.body.data.version).toBe(3);
    expect("data" in current.body && current.body.data.markdown).toContain("first-history-body");
    const versionCount = await env.DB.prepare("SELECT count(*) AS count FROM note_versions WHERE note_id = ?")
      .bind(created.note.id)
      .first<{ count: number }>();
    expect(versionCount?.count).toBe(3);
  });
});
