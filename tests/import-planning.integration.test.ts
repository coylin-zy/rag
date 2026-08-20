import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { sha256 } from "@worker/lib/crypto";

import { apiRequest, createCollection, createNote, jsonInit, queueSendResponse } from "./helpers";

async function createJob(collectionId: string) {
  const result = await apiRequest<{ id: string }>(
    `/api/v1/collections/${collectionId}/import-jobs`,
    { method: "POST" },
  );
  if (!result.response.ok || !("data" in result.body)) throw new Error("Unable to create import job");
  return result.body.data.id;
}

async function upload(jobId: string, relativePath: string, markdown: string, itemId = crypto.randomUUID()) {
  return apiRequest(
    `/api/v1/import-jobs/${jobId}/items/${itemId}`,
    jsonInit("PUT", { relativePath, markdown }),
  );
}

async function currentMarkdown(noteId: string) {
  const result = await apiRequest<{ markdown: string; version: number }>(`/api/v1/notes/${noteId}`);
  if (!("data" in result.body)) throw new Error("Unable to read note");
  return result.body.data;
}

describe("staged markdown import planning", () => {
  it("rejects unsafe paths, secret-bearing markdown and duplicate paths before planning", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Import validation");
    const jobId = await createJob(collection.id);
    const markdown = "---\ntitle: Safe\ntags: []\nstatus: published\n---\n\nSafe body.\n";

    for (const path of ["../escape.md", "/absolute.md", "C:\\escape.md", "history/v1.md", "recovery/note.md", "manifest.json"]) {
      const result = await upload(jobId, path, markdown);
      expect(result.response.status).toBe(422);
    }

    const secret = await upload(
      jobId,
      "secret.md",
      "---\ntitle: Secret\ntags: []\nstatus: published\n---\n\napi_key=sk-abcdefghijklmnopqrstuvwxyz123456\n",
    );
    expect(secret.response.status).toBe(422);

    const first = await upload(jobId, "folder/note.md", markdown);
    expect(first.response.status).toBe(200);
    const duplicate = await upload(jobId, "folder/note.md", markdown.replace("Safe body.", "Changed body."));
    expect(duplicate.response.status).toBe(409);
  });

  it("classifies create, unchanged, update, conflict, deleted conflict and invalid staged items without changing notes", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Import planner");
    const jobId = await createJob(collection.id);

    const createMarkdown = "---\ntitle: New import\ntags: []\nstatus: published\n---\n\nNew import body.\n";
    await upload(jobId, "new.md", createMarkdown);

    const unchanged = await createNote(collection.id, { title: "Unchanged", body: "same-body" });
    const unchangedCurrent = await currentMarkdown(unchanged.note.id);
    await env.DB.prepare("UPDATE notes SET external_path = ?, sync_base_hash = content_hash WHERE id = ?")
      .bind("same.md", unchanged.note.id).run();
    await upload(jobId, "same.md", unchangedCurrent.markdown);

    const updateTarget = await createNote(collection.id, { title: "Update", body: "old-update-body" });
    const updateCurrent = await currentMarkdown(updateTarget.note.id);
    await env.DB.prepare("UPDATE notes SET external_path = ?, sync_base_hash = content_hash WHERE id = ?")
      .bind("update.md", updateTarget.note.id).run();
    await upload(jobId, "update.md", updateCurrent.markdown.replace("old-update-body", "new-update-body"));

    const conflictTarget = await createNote(collection.id, { title: "Conflict", body: "local-change" });
    const conflictCurrent = await currentMarkdown(conflictTarget.note.id);
    await env.DB.prepare("UPDATE notes SET external_path = ?, sync_base_hash = ? WHERE id = ?")
      .bind("conflict.md", await sha256("older-sync-base"), conflictTarget.note.id).run();
    await upload(jobId, "conflict.md", conflictCurrent.markdown.replace("local-change", "incoming-change"));

    const deletedTarget = await createNote(collection.id, { title: "Deleted", body: "deleted-body" });
    const deletedCurrent = await currentMarkdown(deletedTarget.note.id);
    await env.DB.prepare(`
      UPDATE notes SET external_path = ?, sync_base_hash = content_hash, status = 'deleted',
        deleted_at = ?, deleted_from_status = 'published', deleted_by = 'test'
      WHERE id = ?
    `).bind("deleted.md", "2026-08-20T12:00:00.000Z", deletedTarget.note.id).run();
    await upload(jobId, "deleted.md", deletedCurrent.markdown.replace("deleted-body", "incoming-deleted"));

    const invalidItemId = crypto.randomUUID();
    await upload(jobId, "corrupted.md", createMarkdown, invalidItemId);
    await env.NOTES.put(`imports/${jobId}/files/${invalidItemId}.md`, createMarkdown.replace("New import body.", "tampered"));

    const versionsBefore = await env.DB.prepare("SELECT COUNT(*) AS count FROM note_versions").first<{ count: number }>();
    const plan = await apiRequest<{
      status: string;
      planVersion: number;
      items: Array<{ relativePath: string; action: string; errorCode: string | null }>;
    }>(`/api/v1/import-jobs/${jobId}/plan`, { method: "POST" });
    expect(plan.response.status).toBe(200);
    if (!("data" in plan.body)) throw new Error("Plan failed");

    const actions = Object.fromEntries(plan.body.data.items.map((item) => [item.relativePath, item.action]));
    expect(actions).toMatchObject({
      "new.md": "create",
      "same.md": "unchanged",
      "update.md": "update",
      "conflict.md": "conflict",
      "deleted.md": "conflict_deleted",
      "corrupted.md": "invalid",
    });
    expect(plan.body.data.status).toBe("planned");
    expect(plan.body.data.planVersion).toBe(1);

    const versionsAfter = await env.DB.prepare("SELECT COUNT(*) AS count FROM note_versions").first<{ count: number }>();
    expect(versionsAfter?.count).toBe(versionsBefore?.count);

    const frozen = await upload(jobId, "late.md", createMarkdown);
    expect(frozen.response.status).toBe(409);
  });
});
