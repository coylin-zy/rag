import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@worker/env";
import { restoreNoteVersion } from "@worker/services/versionHistory";

import { apiRequest, createCollection, createNote, jsonInit, queueSendResponse } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("version rollback races", () => {
  it("cannot revive a note that is moved to trash while rollback is committing", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Rollback race");
    const created = await createNote(collection.id, { title: "Race target", body: "version one" });
    const current = await apiRequest<{ markdown: string }>(`/api/v1/notes/${created.note.id}`);
    if (!("data" in current.body)) throw new Error("Missing note");
    const updated = await apiRequest<{ version: number }>(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("PUT", { markdown: current.body.data.markdown.replace("version one", "version two") }, { "if-match": '"1"' }),
    );
    expect("data" in updated.body && updated.body.data.version).toBe(2);

    const originalBatch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare(`
        UPDATE notes
        SET status = 'deleted', deleted_at = ?, deleted_from_status = 'published', deleted_by = 'race-test'
        WHERE id = ? AND version = 2
      `).bind("2026-08-20T11:30:00.000Z", created.note.id).run();
      return originalBatch(statements);
    });

    await expect(restoreNoteVersion(
      env as Env,
      { email: "admin@example.com", subject: "dev:admin@example.com", bootstrapAdmin: true },
      created.note.id,
      2,
      1,
    )).rejects.toMatchObject({ status: 409, code: "version_conflict" });

    const note = await env.DB.prepare("SELECT status, version FROM notes WHERE id = ?")
      .bind(created.note.id)
      .first<{ status: string; version: number }>();
    expect(note).toEqual({ status: "deleted", version: 2 });

    const versionThree = await env.DB.prepare("SELECT count(*) AS count FROM note_versions WHERE note_id = ? AND version = 3")
      .bind(created.note.id)
      .first<{ count: number }>();
    expect(versionThree?.count).toBe(0);
    expect(await env.NOTES.get(`versions/${collection.id}/${created.note.id}/3.md`)).toBeNull();
  });
});
