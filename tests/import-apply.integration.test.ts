import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TransferQueueMessage } from "@worker/env";
import { processImportApplyMessage } from "@worker/services/importApply";

import { apiRequest, createCollection, jsonInit, queueSendResponse } from "./helpers";

afterEach(() => vi.restoreAllMocks());

function importedMarkdown(title: string, body: string, reviewedAt = "2026-08-10T00:00:00.000Z") {
  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    "tags: [import]",
    "status: published",
    "source:",
    "  type: url",
    "  uri: https://example.com/source",
    "  label: Exported source",
    "  observed_at: 2026-08-01T00:00:00.000Z",
    `reviewed_at: ${reviewedAt}`,
    "review_after: 2026-12-01T00:00:00.000Z",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

async function createJob(collectionId: string) {
  const result = await apiRequest<{ id: string }>(`/api/v1/collections/${collectionId}/import-jobs`, { method: "POST" });
  if (!("data" in result.body)) throw new Error("create import job failed");
  return result.body.data.id;
}

async function uploadAndPlan(collectionId: string, relativePath: string, markdown: string) {
  const jobId = await createJob(collectionId);
  const itemId = crypto.randomUUID();
  const uploaded = await apiRequest(
    `/api/v1/import-jobs/${jobId}/items/${itemId}`,
    jsonInit("PUT", { relativePath, markdown }),
  );
  expect(uploaded.response.status).toBe(200);
  const planned = await apiRequest<{ planVersion: number; items: Array<{ id: string; action: string }> }>(
    `/api/v1/import-jobs/${jobId}/plan`,
    { method: "POST" },
  );
  if (!("data" in planned.body)) throw new Error("plan failed");
  return { jobId, itemId, planVersion: planned.body.data.planVersion, plan: planned.body.data };
}

async function applyAndCapture(jobId: string, planVersion: number, decisions: unknown[] = []) {
  const sent: TransferQueueMessage[] = [];
  vi.spyOn(env.TRANSFER_QUEUE, "send").mockImplementation(async (message) => {
    sent.push(message as TransferQueueMessage);
    return queueSendResponse();
  });
  const result = await apiRequest(
    `/api/v1/import-jobs/${jobId}/apply`,
    jsonInit("POST", { planVersion, decisions }),
  );
  expect(result.response.status).toBe(200);
  return sent;
}

async function noteByPath(collectionId: string, path: string) {
  return env.DB.prepare(`
    SELECT id, version, content_hash AS contentHash, sync_base_hash AS syncBaseHash,
           reviewed_at AS reviewedAt, source_json AS sourceJson
    FROM notes WHERE collection_id = ? AND external_path = ? LIMIT 1
  `).bind(collectionId, path).first<{
    id: string;
    version: number;
    contentHash: string;
    syncBaseHash: string | null;
    reviewedAt: string | null;
    sourceJson: string | null;
  }>();
}

describe("queued import application", () => {
  it("creates and updates imported notes while preserving provenance and converges replay without duplicate versions", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Import apply");
    const firstMarkdown = importedMarkdown("Imported note", "first imported body");
    const first = await uploadAndPlan(collection.id, "docs/imported.md", firstMarkdown);
    expect(first.plan.items[0]?.action).toBe("create");

    const firstMessages = await applyAndCapture(first.jobId, first.planVersion);
    expect(firstMessages).toHaveLength(1);
    await processImportApplyMessage(env, firstMessages[0]);

    const created = await noteByPath(collection.id, "docs/imported.md");
    expect(created).not.toBeNull();
    expect(created?.version).toBe(1);
    expect(created?.syncBaseHash).toBe(created?.contentHash);
    expect(created?.reviewedAt).toBe("2026-08-10T00:00:00.000Z");
    expect(JSON.parse(created?.sourceJson ?? "null")).toMatchObject({
      type: "url",
      uri: "https://example.com/source",
      observed_at: "2026-08-01T00:00:00.000Z",
    });
    const currentObject = await env.NOTES.get(`notes/${collection.id}/${created?.id}/current.md`);
    expect(await currentObject?.text()).toContain("reviewed_at: 2026-08-10T00:00:00.000Z");

    const secondMarkdown = importedMarkdown("Imported note", "second imported body");
    const second = await uploadAndPlan(collection.id, "docs/imported.md", secondMarkdown);
    expect(second.plan.items[0]?.action).toBe("update");
    const secondMessages = await applyAndCapture(second.jobId, second.planVersion);
    await processImportApplyMessage(env, secondMessages[0]);

    const updated = await noteByPath(collection.id, "docs/imported.md");
    expect(updated?.version).toBe(2);
    expect(updated?.syncBaseHash).toBe(updated?.contentHash);

    await env.DB.prepare(`
      UPDATE transfer_items
      SET status = 'processing', result_note_id = NULL, result_version = NULL, completed_at = NULL
      WHERE id = ? AND job_id = ?
    `).bind(second.itemId, second.jobId).run();
    await env.DB.prepare("UPDATE transfer_jobs SET status = 'processing', completed_at = NULL WHERE id = ?")
      .bind(second.jobId).run();
    await processImportApplyMessage(env, secondMessages[0]);

    const afterReplay = await noteByPath(collection.id, "docs/imported.md");
    expect(afterReplay?.version).toBe(2);
    const versionCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM note_versions WHERE note_id = ?")
      .bind(afterReplay?.id)
      .first<{ count: number }>();
    expect(versionCount?.count).toBe(2);
    const replayedItem = await env.DB.prepare("SELECT status, result_version AS resultVersion FROM transfer_items WHERE id = ?")
      .bind(second.itemId).first<{ status: string; resultVersion: number }>();
    expect(replayedItem).toEqual({ status: "completed", resultVersion: 2 });
  });

  it("fails an item instead of overwriting a note changed after the dry-run plan", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Import stale plan");
    const initial = await uploadAndPlan(collection.id, "stale.md", importedMarkdown("Stale", "v1"));
    const initialMessages = await applyAndCapture(initial.jobId, initial.planVersion);
    await processImportApplyMessage(env, initialMessages[0]);

    const planned = await uploadAndPlan(collection.id, "stale.md", importedMarkdown("Stale", "incoming v2"));
    expect(planned.plan.items[0]?.action).toBe("update");
    const target = await noteByPath(collection.id, "stale.md");
    const detail = await apiRequest<{ markdown: string; version: number }>(`/api/v1/notes/${target?.id}`);
    if (!("data" in detail.body)) throw new Error("note read failed");
    const humanEdit = await apiRequest(
      `/api/v1/notes/${target?.id}`,
      jsonInit("PUT", { markdown: detail.body.data.markdown.replace("v1", "human edit") }, { "if-match": `"${detail.body.data.version}"` }),
    );
    expect(humanEdit.response.status).toBe(200);

    const messages = await applyAndCapture(planned.jobId, planned.planVersion);
    await processImportApplyMessage(env, messages[0]);
    const item = await env.DB.prepare("SELECT status, error_code AS errorCode FROM transfer_items WHERE id = ?")
      .bind(planned.itemId).first<{ status: string; errorCode: string }>();
    expect(item).toEqual({ status: "failed", errorCode: "version_conflict" });
    const current = await noteByPath(collection.id, "stale.md");
    expect(current?.version).toBe(2);
  });

  it("skips conflicts by default and only copies when a new path is explicitly supplied", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Import conflicts");
    const initial = await uploadAndPlan(collection.id, "conflict.md", importedMarkdown("Conflict", "base"));
    const initialMessages = await applyAndCapture(initial.jobId, initial.planVersion);
    await processImportApplyMessage(env, initialMessages[0]);
    const target = await noteByPath(collection.id, "conflict.md");
    await env.DB.prepare("UPDATE notes SET sync_base_hash = ? WHERE id = ?")
      .bind("not-the-current-hash", target?.id).run();

    const conflict = await uploadAndPlan(collection.id, "conflict.md", importedMarkdown("Conflict", "incoming conflict"));
    expect(conflict.plan.items[0]?.action).toBe("conflict");
    const skipped = await applyAndCapture(conflict.jobId, conflict.planVersion);
    expect(skipped).toHaveLength(0);
    expect((await noteByPath(collection.id, "conflict.md"))?.version).toBe(1);

    const copy = await uploadAndPlan(collection.id, "conflict.md", importedMarkdown("Conflict", "incoming copy"));
    expect(copy.plan.items[0]?.action).toBe("conflict");
    const copiedMessages = await applyAndCapture(copy.jobId, copy.planVersion, [{
      itemId: copy.itemId,
      decision: "copy",
      copyPath: "copies/conflict-copy.md",
    }]);
    expect(copiedMessages).toHaveLength(1);
    await processImportApplyMessage(env, copiedMessages[0]);
    const copied = await noteByPath(collection.id, "copies/conflict-copy.md");
    expect(copied?.version).toBe(1);
  });
});
