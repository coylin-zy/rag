import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IndexQueueMessage } from "@worker/env";

import { apiRequest, createCollection, createNote, jsonInit, queueSendResponse, workerFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("management API, D1 and R2", () => {
  it("applies every migration including FTS and scoped audit columns", async () => {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all<{ name: string }>();
    expect(tables.results?.map((row) => row.name)).toEqual(expect.arrayContaining([
      "collections",
      "notes",
      "chunks_fts",
      "api_tokens",
      "audit_logs",
    ]));
    const columns = await env.DB.prepare("PRAGMA table_info(audit_logs)").all<{ name: string }>();
    expect(columns.results?.map((row) => row.name)).toContain("collection_ids_json");
  });

  it("stores canonical Markdown versions in R2 and enforces optimistic locking", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => { sent.push(message); return queueSendResponse(); });
    const collection = await createCollection();
    const created = await createNote(collection.id, { title: "并发版本", body: "第一版" });

    const currentKey = `notes/${collection.id}/${created.note.id}/current.md`;
    const versionOneKey = `versions/${collection.id}/${created.note.id}/1.md`;
    const current = await env.NOTES.get(currentKey);
    const versionOne = await env.NOTES.get(versionOneKey);
    expect(await current?.text()).toContain(`id: ${created.note.id}`);
    expect(await versionOne?.text()).toContain("version: 1");
    expect(versionOne?.customMetadata?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sent).toHaveLength(1);

    const detail = await apiRequest<{ markdown: string; version: number }>(`/api/v1/notes/${created.note.id}`);
    expect(detail.response.headers.get("etag")).toBe('"1"');
    if (!("data" in detail.body)) throw new Error("Missing note detail");

    const noChange = await apiRequest<{ version: number; jobId: string | null }>(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("PUT", { markdown: detail.body.data.markdown }, { "if-match": '"1"' }),
    );
    expect(noChange.response.status).toBe(200);
    expect("data" in noChange.body && noChange.body.data).toMatchObject({ version: 1, jobId: null });

    const nextMarkdown = detail.body.data.markdown.replace("第一版", "第二版");
    const updated = await apiRequest<{ version: number; jobId: string }>(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("PUT", { markdown: nextMarkdown }, { "if-match": 'W/"1"' }),
    );
    expect(updated.response.status).toBe(200);
    expect("data" in updated.body && updated.body.data.version).toBe(2);

    const staleMarkdown = detail.body.data.markdown.replace("第一版", "冲突内容");
    const stale = await apiRequest(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("PUT", { markdown: staleMarkdown }, { "if-match": '"1"' }),
    );
    expect(stale.response.status).toBe(409);
    expect("error" in stale.body && stale.body.error.code).toBe("version_conflict");
    expect(await (await env.NOTES.get(`versions/${collection.id}/${created.note.id}/2.md`))?.text()).toContain("第二版");

    const malformed = await apiRequest(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("PUT", { markdown: nextMarkdown }, { "if-match": "2garbage" }),
    );
    expect(malformed.response.status).toBe(400);
    expect("error" in malformed.body && malformed.body.error.code).toBe("invalid_if_match");
  });

  it("enforces collection roles for edits, proposal review, jobs and tokens", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection();
    const demoteLastAdmin = await apiRequest(
      `/api/v1/collections/${collection.id}/members`,
      jsonInit("PUT", { email: "admin@example.com", role: "viewer" }),
    );
    expect(demoteLastAdmin.response.status).toBe(409);
    expect("error" in demoteLastAdmin.body && demoteLastAdmin.body.error.code).toBe("last_admin");
    const removeLastAdmin = await apiRequest(
      `/api/v1/collections/${collection.id}/members/${encodeURIComponent("admin@example.com")}`,
      { method: "DELETE" },
    );
    expect(removeLastAdmin.response.status).toBe(409);
    await apiRequest(
      `/api/v1/collections/${collection.id}/members`,
      jsonInit("PUT", { email: "editor@example.com", role: "editor" }),
    );
    await apiRequest(
      `/api/v1/collections/${collection.id}/members`,
      jsonInit("PUT", { email: "viewer@example.com", role: "viewer" }),
    );

    const markdown = "---\ntitle: Role test\ntags: []\nstatus: published\n---\n\n# Role test\n\nBody";
    const editorCreate = await apiRequest<{ jobId: string }>(
      `/api/v1/collections/${collection.id}/notes`,
      jsonInit("POST", { markdown }),
      "editor@example.com",
    );
    expect(editorCreate.response.status).toBe(201);
    if (!("data" in editorCreate.body)) throw new Error("Editor note creation failed");
    await env.DB.prepare("UPDATE index_jobs SET status = 'failed' WHERE id = ?").bind(editorCreate.body.data.jobId).run();

    const guessedRetry = await apiRequest(
      `/api/v1/jobs/${editorCreate.body.data.jobId}/retry`,
      { method: "POST" },
      "viewer@example.com",
    );
    expect(guessedRetry.response.status).toBe(403);
    const editorRetry = await apiRequest(
      `/api/v1/jobs/${editorCreate.body.data.jobId}/retry`,
      { method: "POST" },
      "editor@example.com",
    );
    expect(editorRetry.response.status).toBe(200);

    const viewerCreate = await apiRequest(
      `/api/v1/collections/${collection.id}/notes`,
      jsonInit("POST", { markdown }),
      "viewer@example.com",
    );
    expect(viewerCreate.response.status).toBe(403);

    const outsiderList = await apiRequest(`/api/v1/collections/${collection.id}/notes`, {}, "outsider@example.com");
    expect(outsiderList.response.status).toBe(404);

    const tokenAttempt = await apiRequest(
      "/api/v1/tokens",
      jsonInit("POST", { name: "editor token", collectionIds: [collection.id], scopes: ["knowledge:read"], expiresAt: null }),
      "editor@example.com",
    );
    expect(tokenAttempt.response.status).toBe(403);

    const jobsForViewer = await apiRequest<unknown[]>("/api/v1/jobs", {}, "viewer@example.com");
    expect("data" in jobsForViewer.body && jobsForViewer.body.data).toEqual([]);
  });

  it("deletes only unused collections with administrator permission and records the purge", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const missingDelete = await apiRequest(
      "/api/v1/collections/00000000-0000-4000-8000-000000000000",
      { method: "DELETE" },
    );
    expect(missingDelete.response.status).toBe(404);
    expect("error" in missingDelete.body && missingDelete.body.error.code).toBe("collection_not_found");

    const collection = await createCollection("Disposable knowledge");
    await apiRequest(
      `/api/v1/collections/${collection.id}/members`,
      jsonInit("PUT", { email: "viewer-delete@example.com", role: "viewer" }),
    );

    const viewerDelete = await apiRequest(
      `/api/v1/collections/${collection.id}`,
      { method: "DELETE" },
      "viewer-delete@example.com",
    );
    expect(viewerDelete.response.status).toBe(403);

    const outsiderDelete = await apiRequest(
      `/api/v1/collections/${collection.id}`,
      { method: "DELETE" },
      "outsider-delete@example.com",
    );
    expect(outsiderDelete.response.status).toBe(404);

    const created = await createNote(collection.id, { title: "Temporary note", body: "Delete me safely" });
    const nonEmptyDelete = await apiRequest(`/api/v1/collections/${collection.id}`, { method: "DELETE" });
    expect(nonEmptyDelete.response.status).toBe(409);
    expect("error" in nonEmptyDelete.body && nonEmptyDelete.body.error.code).toBe("collection_not_empty");

    const token = await apiRequest<{ id: string }>(
      "/api/v1/tokens",
      jsonInit("POST", {
        name: "Temporary collection token",
        collectionIds: [collection.id],
        scopes: ["knowledge:read"],
        expiresAt: null,
      }),
    );
    expect(token.response.status).toBe(201);
    if (!("data" in token.body)) throw new Error("Token creation failed");

    const noteDelete = await apiRequest(`/api/v1/notes/${created.note.id}`, { method: "DELETE" });
    expect(noteDelete.response.status).toBe(200);
    const tokenBlockedDelete = await apiRequest(`/api/v1/collections/${collection.id}`, { method: "DELETE" });
    expect(tokenBlockedDelete.response.status).toBe(409);
    expect("error" in tokenBlockedDelete.body && tokenBlockedDelete.body.error.code).toBe("collection_has_active_tokens");

    const revoke = await apiRequest(`/api/v1/tokens/${token.body.data.id}`, { method: "DELETE" });
    expect(revoke.response.status).toBe(200);
    const deleted = await apiRequest<{ deleted: boolean; collectionId: string }>(
      `/api/v1/collections/${collection.id}`,
      { method: "DELETE" },
    );
    expect(deleted.response.status).toBe(200);
    expect("data" in deleted.body && deleted.body.data).toEqual({ deleted: true, collectionId: collection.id });

    expect(await env.DB.prepare("SELECT id FROM collections WHERE id = ?").bind(collection.id).first()).toBeNull();
    expect(await env.NOTES.get(`notes/${collection.id}/${created.note.id}/current.md`)).toBeNull();
    expect(await env.NOTES.get(`versions/${collection.id}/${created.note.id}/1.md`)).toBeNull();
    const audit = await env.DB.prepare(
      "SELECT action, metadata_json AS metadataJson FROM audit_logs WHERE resource_id = ? AND action = 'collection.delete'",
    ).bind(collection.id).first<{ action: string; metadataJson: string }>();
    expect(audit?.action).toBe("collection.delete");
    expect(JSON.parse(audit?.metadataJson ?? "{}")).toMatchObject({ deletedNoteHistory: 1, deletedObjects: 2 });
  });

  it("returns only knowledge-base-scoped audit events to administrators", async () => {
    const collection = await createCollection();
    await apiRequest(
      `/api/v1/collections/${collection.id}/members`,
      jsonInit("PUT", { email: "collection-admin@example.com", role: "admin" }),
    );
    const scoped = await apiRequest<Array<{ action: string; collectionIds: string[] }>>(
      `/api/v1/audit?collectionId=${collection.id}`,
      {},
      "collection-admin@example.com",
    );
    expect(scoped.response.status).toBe(200);
    expect("data" in scoped.body && scoped.body.data.some((event) => event.action === "member.upsert")).toBe(true);
    expect("data" in scoped.body && scoped.body.data.every((event) => event.collectionIds.includes(collection.id))).toBe(true);

    const forbidden = await apiRequest(`/api/v1/audit?collectionId=${collection.id}`, {}, "outsider@example.com");
    expect(forbidden.response.status).toBe(404);
  });

  it("exposes only a minimal health response and caps retrieval at eight results", async () => {
    const health = await apiRequest<{ status: string }>("/healthz");
    expect(health.response.status).toBe(200);
    expect(health.body).toEqual({ status: "ok" });

    const collection = await createCollection();
    const invalid = await apiRequest(
      "/api/v1/search",
      jsonInit("POST", { query: "test", collectionIds: [collection.id], tags: [], limit: 9 }),
    );
    expect(invalid.response.status).toBe(422);
    expect("error" in invalid.body && invalid.body.error.code).toBe("validation_error");
  });

  it("keeps client-controlled values and exception details out of structured logs", async () => {
    const injectedRequestId = "kcore_DO_NOT_LOG_REQUEST_TOKEN";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(env.DB, "prepare").mockImplementationOnce(() => {
      const error = new Error("MARKDOWN-BODY-DO-NOT-LOG");
      error.name = "MODEL_API_KEY_DO_NOT_LOG";
      throw error;
    });

    const response = await workerFetch("/api/v1/collections", { headers: { "x-request-id": injectedRequestId } });
    const body = await response.json() as { requestId: string; error: { code: string } };
    expect(response.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.requestId).not.toBe(injectedRequestId);

    const logs = consoleError.mock.calls.flat().join(" ");
    expect(logs).toContain('"event":"request.error"');
    expect(logs).not.toContain(injectedRequestId);
    expect(logs).not.toContain("MARKDOWN-BODY-DO-NOT-LOG");
    expect(logs).not.toContain("MODEL_API_KEY_DO_NOT_LOG");
  });
});
