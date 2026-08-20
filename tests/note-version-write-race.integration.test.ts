import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@worker/env";
import { updateNote } from "@worker/services/notes";
import { reviewNote } from "@worker/services/review";

import { apiRequest, createCollection, createNote, queueSendResponse } from "./helpers";

afterEach(() => vi.restoreAllMocks());

const admin = { email: "admin@example.com", subject: "dev:admin@example.com", bootstrapAdmin: true } as const;

async function assertNoVersionTwo(collectionId: string, noteId: string) {
  const note = await env.DB.prepare("SELECT status, version FROM notes WHERE id = ?")
    .bind(noteId)
    .first<{ status: string; version: number }>();
  expect(note).toEqual({ status: "deleted", version: 1 });

  const history = await env.DB.prepare("SELECT count(*) AS count FROM note_versions WHERE note_id = ? AND version = 2")
    .bind(noteId)
    .first<{ count: number }>();
  expect(history?.count).toBe(0);
  expect(await env.NOTES.get(`versions/${collectionId}/${noteId}/2.md`)).toBeNull();
}

describe("note version write races", () => {
  it("does not leave an orphan version when trash wins against a normal edit", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Edit race");
    const created = await createNote(collection.id, { title: "Edit race target", body: "original body" });
    const current = await apiRequest<{ markdown: string }>(`/api/v1/notes/${created.note.id}`);
    if (!("data" in current.body)) throw new Error("Missing current note");
    const nextMarkdown = current.body.data.markdown.replace("original body", "edited body");

    const originalBatch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare(`
        UPDATE notes
        SET status = 'deleted', deleted_at = ?, deleted_from_status = 'published', deleted_by = 'race-test'
        WHERE id = ? AND version = 1
      `).bind("2026-08-20T12:00:00.000Z", created.note.id).run();
      return originalBatch(statements);
    });

    await expect(updateNote(env as Env, admin, created.note.id, 1, nextMarkdown))
      .rejects.toMatchObject({ status: 409, code: "version_conflict" });

    await assertNoVersionTwo(collection.id, created.note.id);
  });

  it("does not leave an orphan review version when trash wins against human review", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Review race");
    const created = await createNote(collection.id, { title: "Review race target", body: "review body" });

    const originalBatch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare(`
        UPDATE notes
        SET status = 'deleted', deleted_at = ?, deleted_from_status = 'published', deleted_by = 'race-test'
        WHERE id = ? AND version = 1
      `).bind("2026-08-20T12:05:00.000Z", created.note.id).run();
      return originalBatch(statements);
    });

    await expect(reviewNote(env as Env, admin, created.note.id, 1, "2999-01-01T00:00:00.000Z"))
      .rejects.toMatchObject({ status: 409, code: "version_conflict" });

    await assertNoVersionTwo(collection.id, created.note.id);
  });
});
