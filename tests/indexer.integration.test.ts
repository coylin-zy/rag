import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env, IndexQueueMessage } from "@worker/env";
import { handleIndexQueue, processIndexMessage } from "@worker/services/indexer";

import { apiRequest, createCollection, createNote, jsonInit, queueSendResponse } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function mockVectorize() {
  const vectors = new Map<string, VectorizeVector>();
  const upsert = vi.spyOn(env.VECTOR_INDEX, "upsert").mockImplementation(async (batch) => {
    batch.forEach((vector) => vectors.set(vector.id, vector));
    return { mutationId: crypto.randomUUID(), ids: batch.map((vector) => vector.id), count: batch.length };
  });
  const deleteByIds = vi.spyOn(env.VECTOR_INDEX, "deleteByIds").mockImplementation(async (ids) => {
    ids.forEach((id) => vectors.delete(id));
    return { mutationId: crypto.randomUUID(), ids, count: ids.length };
  });
  const query = vi.spyOn(env.VECTOR_INDEX, "query").mockResolvedValue({ count: 0, matches: [] });
  return { vectors, upsert, query, deleteByIds };
}

describe("index Queue pipeline", () => {
  it("indexes Markdown idempotently, supports Chinese FTS and fully deindexes deletes", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    const { vectors, query } = mockVectorize();
    const collection = await createCollection();
    const created = await createNote(collection.id, {
      title: "部署手册",
      tags: ["Cloudflare", "编号"],
      body: "生产环境的部署编号是 CF-2048。请在变更单中保留该精确编号。",
    });
    const indexMessage = sent[0];
    expect(indexMessage.type).toBe("index");

    await processIndexMessage(env as Env, indexMessage);
    const indexed = await env.DB.prepare("SELECT indexed_version AS version FROM notes WHERE id = ?").bind(created.note.id).first<{ version: number }>();
    const firstCount = await env.DB.prepare("SELECT count(*) AS count FROM chunks WHERE note_id = ?").bind(created.note.id).first<{ count: number }>();
    expect(indexed?.version).toBe(1);
    expect(firstCount?.count).toBeGreaterThan(0);
    expect(vectors.size).toBe(firstCount?.count);
    expect([...vectors.values()][0].values).toHaveLength(1024);
    expect([...vectors.values()][0].metadata).toMatchObject({ collection_id: collection.id, note_id: created.note.id, version: 1 });

    await processIndexMessage(env as Env, indexMessage);
    const secondCount = await env.DB.prepare("SELECT count(*) AS count FROM chunks WHERE note_id = ?").bind(created.note.id).first<{ count: number }>();
    expect(secondCount?.count).toBe(firstCount?.count);
    expect(vectors.size).toBe(firstCount?.count);

    const search = await apiRequest<Array<{ noteId: string; excerpt: string }>>(
      "/api/v1/search",
      jsonInit("POST", { query: "部署编号", collectionIds: [collection.id], tags: ["编号"], limit: 8 }),
    );
    expect(search.response.status).toBe(200);
    expect("data" in search.body && search.body.data[0]).toMatchObject({ noteId: created.note.id });
    expect("data" in search.body && search.body.data[0].excerpt).toContain("CF-2048");

    const exactCode = await apiRequest<Array<{ noteId: string }>>(
      "/api/v1/search",
      jsonInit("POST", { query: "CF-2048", collectionIds: [collection.id], tags: [], limit: 8 }),
    );
    expect("data" in exactCode.body && exactCode.body.data[0]?.noteId).toBe(created.note.id);

    const chunkId = [...vectors.keys()][0];
    query.mockResolvedValue({ count: 1, matches: [{ id: chunkId, score: 0.98, metadata: { collection_id: collection.id } }] });
    const semantic = await apiRequest<Array<{ noteId: string }>>(
      "/api/v1/search",
      jsonInit("POST", { query: "上线时使用的变更标识", collectionIds: [collection.id], tags: [], limit: 8 }),
    );
    expect("data" in semantic.body && semantic.body.data[0]?.noteId).toBe(created.note.id);

    const deletion = await apiRequest<{ jobId: string }>(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("DELETE", { reason: "index cleanup" }, { "if-match": `"${created.note.version}"` }),
    );
    expect(deletion.response.status).toBe(200);
    const deleteMessage = sent.find((message) => message.type === "delete");
    if (!deleteMessage) throw new Error("Delete message was not queued");
    await processIndexMessage(env as Env, deleteMessage);
    expect((await env.DB.prepare("SELECT count(*) AS count FROM chunks WHERE note_id = ?").bind(created.note.id).first<{ count: number }>())?.count).toBe(0);
    expect(vectors.size).toBe(0);
    const afterDelete = await apiRequest<unknown[]>(
      "/api/v1/search",
      jsonInit("POST", { query: "部署编号", collectionIds: [collection.id], tags: [], limit: 8 }),
    );
    expect("data" in afterDelete.body && afterDelete.body.data).toEqual([]);
    expect(await env.NOTES.get(`versions/${collection.id}/${created.note.id}/1.md`)).not.toBeNull();
  });

  it("rechecks collection scope while hydrating Vectorize candidates", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    const { vectors, query } = mockVectorize();
    const allowed = await createCollection("Allowed vector scope");
    const forbidden = await createCollection("Forbidden vector scope");
    await createNote(allowed.id, { title: "Allowed", body: "ALLOWED-SCOPE-112" });
    const secret = await createNote(forbidden.id, { title: "Secret", body: "SECRET-SCOPE-998" });
    for (const message of sent) await processIndexMessage(env as Env, message);

    const forbiddenVector = [...vectors.values()].find((vector) => vector.metadata?.collection_id === forbidden.id);
    if (!forbiddenVector) throw new Error("Missing forbidden vector");
    query.mockResolvedValue({
      count: 1,
      matches: [{ id: forbiddenVector.id, score: 0.99, metadata: { collection_id: forbidden.id } }],
    });

    const search = await apiRequest<Array<{ noteId: string; excerpt: string }>>(
      "/api/v1/search",
      jsonInit("POST", { query: "unmatched semantic query", collectionIds: [allowed.id], tags: [], limit: 8 }),
    );
    expect(search.response.status).toBe(200);
    expect("data" in search.body && search.body.data.some((result) => result.noteId === secret.note.id)).toBe(false);
    expect(JSON.stringify(search.body)).not.toContain("SECRET-SCOPE-998");
  });

  it("marks failed jobs and requests Queue retry without exposing an active partial index", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    mockVectorize();
    const collection = await createCollection();
    const created = await createNote(collection.id, { title: "Missing source", body: "Source" });
    const message = sent[0];
    await env.NOTES.delete(`versions/${collection.id}/${created.note.id}/1.md`);

    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      queue: "knowledge-core-test-index",
      messages: [{ id: "message-1", timestamp: new Date(), attempts: 1, body: message, ack, retry }],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<IndexQueueMessage>;
    await handleIndexQueue(batch, env as Env);
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    const job = await env.DB.prepare("SELECT status, last_error AS lastError FROM index_jobs WHERE id = ?").bind(message.jobId).first<{ status: string; lastError: string }>();
    expect(job?.status).toBe("failed");
    expect(job?.lastError).toContain("R2");
    expect((await env.DB.prepare("SELECT indexed_version AS version FROM notes WHERE id = ?").bind(created.note.id).first<{ version: number | null }>())?.version).toBeNull();
  });

  it("keeps partial vector failures invisible and rebuilds without duplicate chunks", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    const { vectors, upsert } = mockVectorize();
    const collection = await createCollection();
    const created = await createNote(collection.id, { title: "Atomic activation", body: "PARTIAL-INDEX-518" });
    const message = sent[0];

    upsert.mockRejectedValueOnce(new Error("vector write unavailable"));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ data: body.input.map(() => ({ embedding: Array.from({ length: 1024 }, () => 0.01) })) });
    });
    const productionEnv = {
      ...env,
      ENVIRONMENT: "production",
      EMBEDDING_BASE_URL: "https://embedding.test/v1",
      EMBEDDING_API_KEY: "test-secret",
      EMBEDDING_MODEL: "test-1024",
    } as Env;
    await expect(processIndexMessage(productionEnv, message)).rejects.toThrow("vector write unavailable");
    expect((await env.DB.prepare("SELECT indexed_version AS version FROM notes WHERE id = ?").bind(created.note.id).first<{ version: number | null }>())?.version).toBeNull();
    expect((await env.DB.prepare("SELECT count(*) AS count FROM chunks WHERE note_id = ?").bind(created.note.id).first<{ count: number }>())?.count).toBeGreaterThan(0);

    const hidden = await apiRequest<unknown[]>(
      "/api/v1/search",
      jsonInit("POST", { query: "PARTIAL-INDEX-518", collectionIds: [collection.id], tags: [], limit: 8 }),
    );
    expect("data" in hidden.body && hidden.body.data).toEqual([]);

    await processIndexMessage(env as Env, message);
    const rows = await env.DB.prepare("SELECT count(*) AS count, count(DISTINCT id) AS uniqueCount FROM chunks WHERE note_id = ?")
      .bind(created.note.id)
      .first<{ count: number; uniqueCount: number }>();
    expect(rows?.count).toBe(rows?.uniqueCount);
    expect(vectors.size).toBe(rows?.count);
    expect((await env.DB.prepare("SELECT indexed_version AS version FROM notes WHERE id = ?").bind(created.note.id).first<{ version: number }>())?.version).toBe(1);
  });

  it("retries stale vector cleanup after the new version is already active", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    const { vectors, deleteByIds } = mockVectorize();
    const collection = await createCollection();
    const created = await createNote(collection.id, { title: "Cleanup retry", body: "old-cleanup-value" });
    await processIndexMessage(env as Env, sent[0]);

    const detail = await apiRequest<{ markdown: string }>(`/api/v1/notes/${created.note.id}`);
    if (!("data" in detail.body)) throw new Error("Missing note detail");
    await apiRequest(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("PUT", { markdown: detail.body.data.markdown.replace("old-cleanup-value", "new-cleanup-value") }, { "if-match": '"1"' }),
    );
    const secondMessage = sent.find((message) => message.type === "index" && message.version === 2);
    if (!secondMessage) throw new Error("Version two was not queued");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Response.json({ data: body.input.map(() => ({ embedding: Array.from({ length: 1024 }, () => 0.01) })) });
    });
    const productionEnv = {
      ...env,
      ENVIRONMENT: "production",
      EMBEDDING_BASE_URL: "https://embedding.test/v1",
      EMBEDDING_API_KEY: "test-secret",
      EMBEDDING_MODEL: "test-1024",
    } as Env;
    deleteByIds.mockRejectedValueOnce(new Error("vector cleanup unavailable"));

    await expect(processIndexMessage(productionEnv, secondMessage)).rejects.toThrow("vector cleanup unavailable");
    expect((await env.DB.prepare("SELECT indexed_version AS version FROM notes WHERE id = ?").bind(created.note.id).first<{ version: number }>())?.version).toBe(2);
    expect((await env.DB.prepare("SELECT count(DISTINCT version) AS count FROM chunks WHERE note_id = ?").bind(created.note.id).first<{ count: number }>())?.count).toBe(2);

    await processIndexMessage(productionEnv, secondMessage);
    const versions = await env.DB.prepare("SELECT DISTINCT version FROM chunks WHERE note_id = ?").bind(created.note.id).all<{ version: number }>();
    expect(versions.results).toEqual([{ version: 2 }]);
    expect([...vectors.values()].every((vector) => vector.metadata?.version === 2)).toBe(true);
  });

  it("does not let a stale Queue message replace a newer active version", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    const { vectors } = mockVectorize();
    const collection = await createCollection();
    const created = await createNote(collection.id, { title: "Ordering", body: "old-value" });
    const firstMessage = sent[0];
    const detail = await apiRequest<{ markdown: string }>(`/api/v1/notes/${created.note.id}`);
    if (!("data" in detail.body)) throw new Error("Missing note detail");
    const updated = await apiRequest(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("PUT", { markdown: detail.body.data.markdown.replace("old-value", "new-value") }, { "if-match": '"1"' }),
    );
    expect(updated.response.status).toBe(200);
    const secondMessage = sent.find((message) => message.type === "index" && message.version === 2);
    if (!secondMessage) throw new Error("Version two was not queued");

    await processIndexMessage(env as Env, secondMessage);
    await processIndexMessage(env as Env, firstMessage);
    const versions = await env.DB.prepare("SELECT DISTINCT version FROM chunks WHERE note_id = ?").bind(created.note.id).all<{ version: number }>();
    expect(versions.results).toEqual([{ version: 2 }]);
    expect([...vectors.values()].every((vector) => vector.metadata?.version === 2)).toBe(true);
    expect((await env.DB.prepare("SELECT indexed_version AS version FROM notes WHERE id = ?").bind(created.note.id).first<{ version: number }>())?.version).toBe(2);
  });
});
