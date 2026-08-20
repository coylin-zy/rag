import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { IndexQueueMessage } from "@worker/env";

import { apiRequest, createCollection, createNote, jsonInit, queueSendResponse } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("version history and rollback", () => {
  it("reads immutable history and restores as a new version with optimistic locking", async () => {
    const sent: IndexQueueMessage[] = [];
    vi.spyOn(env.INDEX_QUEUE, "send").mockImplementation(async (message) => {
      sent.push(message);
      return queueSendResponse();
    });

    const collection = await createCollection("Version history");
    const created = await createNote(collection.id, { title: "Rollback target", body: "第一版正文" });
    const noteId = created.note.id;

    const firstVersion = await apiRequest<{ version: number; currentVersion: number; markdown: string }>(
      `/api/v1/notes/${noteId}/versions/1`,
    );
    expect(firstVersion.response.status).toBe(200);
    expect(firstVersion.response.headers.get("etag")).toBe('"1"');
    expect("data" in firstVersion.body && firstVersion.body.data.markdown).toContain("第一版正文");

    const current = await apiRequest<{ version: number; markdown: string }>(`/api/v1/notes/${noteId}`);
    if (!("data" in current.body)) throw new Error("Missing current note");
    const secondMarkdown = current.body.data.markdown.replace("第一版正文", "第二版正文");
    const updated = await apiRequest<{ version: number }>(
      `/api/v1/notes/${noteId}`,
      jsonInit("PUT", { markdown: secondMarkdown }, { "if-match": '"1"' }),
    );
    expect(updated.response.status).toBe(200);
    expect("data" in updated.body && updated.body.data.version).toBe(2);

    const immutableFirst = await apiRequest<{ markdown: string }>(`/api/v1/notes/${noteId}/versions/1`);
    expect("data" in immutableFirst.body && immutableFirst.body.data.markdown).toContain("第一版正文");
    expect("data" in immutableFirst.body && immutableFirst.body.data.markdown).not.toContain("第二版正文");

    const missingIfMatch = await apiRequest(
      `/api/v1/notes/${noteId}/restore`,
      jsonInit("POST", { version: 1 }),
    );
    expect(missingIfMatch.response.status).toBe(400);
    expect("error" in missingIfMatch.body && missingIfMatch.body.error.code).toBe("if_match_required");

    const staleRestore = await apiRequest(
      `/api/v1/notes/${noteId}/restore`,
      jsonInit("POST", { version: 1 }, { "if-match": '"1"' }),
    );
    expect(staleRestore.response.status).toBe(409);
    expect("error" in staleRestore.body && staleRestore.body.error.code).toBe("version_conflict");

    await apiRequest(
      `/api/v1/collections/${collection.id}/members`,
      jsonInit("PUT", { email: "viewer@example.com", role: "viewer" }),
    );
    const viewerRead = await apiRequest(`/api/v1/notes/${noteId}/versions/1`, {}, "viewer@example.com");
    expect(viewerRead.response.status).toBe(200);
    const viewerRestore = await apiRequest(
      `/api/v1/notes/${noteId}/restore`,
      jsonInit("POST", { version: 1 }, { "if-match": '"2"' }),
      "viewer@example.com",
    );
    expect(viewerRestore.response.status).toBe(403);

    const restored = await apiRequest<{ version: number; sourceVersion: number; previousVersion: number; jobId: string }>(
      `/api/v1/notes/${noteId}/restore`,
      jsonInit("POST", { version: 1 }, { "if-match": '"2"' }),
    );
    expect(restored.response.status).toBe(200);
    expect(restored.response.headers.get("etag")).toBe('"3"');
    expect("data" in restored.body && restored.body.data).toMatchObject({
      version: 3,
      sourceVersion: 1,
      previousVersion: 2,
    });

    const versionOneObject = await env.NOTES.get(`versions/${collection.id}/${noteId}/1.md`);
    const versionThreeObject = await env.NOTES.get(`versions/${collection.id}/${noteId}/3.md`);
    expect(await versionOneObject?.text()).toContain("version: 1");
    expect(await versionOneObject?.text()).toContain("第一版正文");
    expect(await versionThreeObject?.text()).toContain("version: 3");
    expect(await versionThreeObject?.text()).toContain("第一版正文");

    const detailAfterRestore = await apiRequest<{ version: number; markdown: string }>(`/api/v1/notes/${noteId}`);
    expect("data" in detailAfterRestore.body && detailAfterRestore.body.data.version).toBe(3);
    expect("data" in detailAfterRestore.body && detailAfterRestore.body.data.markdown).toContain("第一版正文");

    const audit = await env.DB.prepare(`
      SELECT metadata_json AS metadataJson
      FROM audit_logs
      WHERE action = 'note.restore_version' AND resource_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).bind(noteId).first<{ metadataJson: string }>();
    expect(JSON.parse(audit?.metadataJson ?? "{}")).toMatchObject({
      sourceVersion: 1,
      currentVersion: 2,
      restoredVersion: 3,
    });

    expect(sent.filter((message) => message.type === "index" && message.noteId === noteId).map((message) => message.version))
      .toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it("does not leak historical versions to an unrelated user", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Version permissions");
    const created = await createNote(collection.id, { title: "Private history", body: "secret-ish test content" });

    const guessed = await apiRequest(
      `/api/v1/notes/${created.note.id}/versions/1`,
      {},
      "outsider@example.com",
    );
    expect(guessed.response.status).toBe(404);
  });
});
