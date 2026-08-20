import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiRequest, createCollection, createNote, jsonInit, queueSendResponse, workerFetch } from "./helpers";

interface ExportManifest {
  kind: "portable" | "full_backup";
  includesHistory: boolean;
  includesTrash: boolean;
  notes: Array<{ id: string; path: string; version: number; contentHash: string }>;
  objects: Array<{
    id: string;
    logicalPath: string;
    objectKind: string;
    noteId: string | null;
    noteVersion: number | null;
    sha256: string;
    byteSize: number;
  }>;
}

async function createExport(collectionId: string, kind: "portable" | "backup") {
  const created = await apiRequest<{ id: string; manifestHash: string }>(
    `/api/v1/collections/${collectionId}/export-jobs`,
    jsonInit("POST", { kind }),
  );
  expect(created.response.status).toBe(201);
  if (!("data" in created.body)) throw new Error("export creation failed");
  return created.body.data;
}

async function readManifest(jobId: string) {
  const result = await apiRequest<{ manifest: ExportManifest; manifestHash: string }>(
    `/api/v1/export-jobs/${jobId}/manifest`,
  );
  if (!("data" in result.body)) throw new Error("manifest read failed");
  return { response: result.response, ...result.body.data };
}

async function fetchExportObject(jobId: string, objectId: string) {
  const response = await workerFetch(`/api/v1/export-jobs/${jobId}/objects/${objectId}`);
  return { response, text: await response.text() };
}

async function createImportJob(collectionId: string) {
  const created = await apiRequest<{ id: string }>(
    `/api/v1/collections/${collectionId}/import-jobs`,
    { method: "POST" },
  );
  if (!("data" in created.body)) throw new Error("import job creation failed");
  return created.body.data.id;
}

describe("portable export and full backup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("round-trips a legacy note without external_path as unchanged", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Portable roundtrip");
    const created = await createNote(collection.id, { title: "Portable note", body: "portable-marker-17" });
    const before = await env.DB.prepare("SELECT external_path AS externalPath FROM notes WHERE id = ?")
      .bind(created.note.id).first<{ externalPath: string | null }>();
    expect(before?.externalPath).toBeNull();

    const exported = await createExport(collection.id, "portable");
    const manifest = await readManifest(exported.id);
    expect(manifest.manifest.kind).toBe("portable");
    expect(manifest.manifest.includesHistory).toBe(false);
    expect(manifest.manifest.includesTrash).toBe(false);
    expect(manifest.manifest.notes).toEqual([
      expect.objectContaining({ id: created.note.id, path: `${created.note.id}.md`, version: 1 }),
    ]);

    const markdownObject = manifest.manifest.objects.find((object) => object.objectKind === "current_markdown");
    expect(markdownObject).toBeDefined();
    const downloaded = await fetchExportObject(exported.id, markdownObject!.id);
    expect(downloaded.response.status).toBe(200);
    expect(downloaded.response.headers.get("x-content-sha256")).toBe(markdownObject!.sha256);
    expect(downloaded.text).toContain("portable-marker-17");

    const importJobId = await createImportJob(collection.id);
    const itemId = crypto.randomUUID();
    const uploaded = await apiRequest(
      `/api/v1/import-jobs/${importJobId}/items/${itemId}`,
      jsonInit("PUT", { relativePath: `${created.note.id}.md`, markdown: downloaded.text }),
    );
    expect(uploaded.response.status).toBe(200);
    const planned = await apiRequest<{ items: Array<{ action: string; targetNoteId: string | null }> }>(
      `/api/v1/import-jobs/${importJobId}/plan`,
      { method: "POST" },
    );
    expect("data" in planned.body && planned.body.data.items).toEqual([
      expect.objectContaining({ action: "unchanged", targetNoteId: created.note.id }),
    ]);
  });

  it("full backup includes trash, immutable history and only non-secret recovery metadata", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Full backup");
    const historical = await createNote(collection.id, { title: "History", body: "history-v1" });
    const detail = await apiRequest<{ markdown: string; version: number }>(`/api/v1/notes/${historical.note.id}`);
    if (!("data" in detail.body)) throw new Error("note read failed");
    const updated = await apiRequest<{ version: number }>(
      `/api/v1/notes/${historical.note.id}`,
      jsonInit("PUT", { markdown: detail.body.data.markdown.replace("history-v1", "history-v2") }, { "if-match": '"1"' }),
    );
    expect("data" in updated.body && updated.body.data.version).toBe(2);
    const deleted = await apiRequest(
      `/api/v1/notes/${historical.note.id}`,
      jsonInit("DELETE", { reason: "backup trash fixture" }, { "if-match": '"2"' }),
    );
    expect(deleted.response.status).toBe(200);
    const active = await createNote(collection.id, { title: "Active", body: "active-backup-marker" });

    const token = await apiRequest<{ id: string; token: string }>(
      "/api/v1/tokens",
      jsonInit("POST", {
        name: "Backup exclusion token",
        collectionIds: [collection.id],
        scopes: ["knowledge:read"],
        expiresAt: null,
      }),
    );
    if (!("data" in token.body)) throw new Error("token creation failed");

    const exported = await createExport(collection.id, "backup");
    const manifest = await readManifest(exported.id);
    expect(manifest.manifest.kind).toBe("full_backup");
    expect(manifest.manifest.includesHistory).toBe(true);
    expect(manifest.manifest.includesTrash).toBe(true);
    const logicalPaths = manifest.manifest.objects.map((object) => object.logicalPath);
    expect(logicalPaths).toEqual(expect.arrayContaining([
      "recovery/collections.json",
      "recovery/notes.json",
      "recovery/versions.json",
      `history/${historical.note.id}/1.md`,
      `history/${historical.note.id}/2.md`,
      `history/${active.note.id}/1.md`,
    ]));

    let allMetadata = "";
    for (const object of manifest.manifest.objects.filter((candidate) => candidate.logicalPath.startsWith("recovery/"))) {
      const downloaded = await fetchExportObject(exported.id, object.id);
      expect(downloaded.response.status).toBe(200);
      allMetadata += downloaded.text;
    }
    expect(allMetadata).toContain(historical.note.id);
    expect(allMetadata).toContain('"status": "deleted"');
    expect(allMetadata).not.toContain(token.body.data.token);
    expect(allMetadata).not.toContain("token_hash");
    expect(allMetadata).not.toContain("ADMIN_SESSION_SECRET");
    expect(allMetadata).not.toContain("ADMIN_LOGIN_PASSWORD_HASH");

    const verify = await apiRequest(
      `/api/v1/export-jobs/${exported.id}/verify`,
      jsonInit("POST", {
        manifestHash: exported.manifestHash,
        reportHash: "a".repeat(64),
      }),
    );
    expect(verify.response.status).toBe(200);
    const verified = await env.DB.prepare(`
      SELECT verified_at AS verifiedAt, verification_hash AS verificationHash
      FROM transfer_jobs WHERE id = ?
    `).bind(exported.id).first<{ verifiedAt: string | null; verificationHash: string | null }>();
    expect(verified?.verifiedAt).toBeTruthy();
    expect(verified?.verificationHash).toBe("a".repeat(64));
  });

  it("rejects tampered frozen manifests and export objects", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Export integrity");
    await createNote(collection.id, { title: "Integrity", body: "integrity-marker" });

    const first = await createExport(collection.id, "portable");
    const firstManifest = await readManifest(first.id);
    const object = firstManifest.manifest.objects.find((candidate) => candidate.objectKind === "current_markdown");
    expect(object).toBeDefined();
    const row = await env.DB.prepare("SELECT r2_key AS r2Key FROM transfer_export_objects WHERE id = ?")
      .bind(object!.id).first<{ r2Key: string }>();
    expect(row?.r2Key).toBeTruthy();
    await env.NOTES.put(row!.r2Key, "tampered export object");
    const tamperedObject = await fetchExportObject(first.id, object!.id);
    expect(tamperedObject.response.status).toBe(503);

    const second = await createExport(collection.id, "portable");
    await env.NOTES.put(`exports/${second.id}/manifest.json`, "{\"tampered\":true}\n");
    const manifestResponse = await apiRequest(`/api/v1/export-jobs/${second.id}/manifest`);
    expect(manifestResponse.response.status).toBe(503);
    expect("error" in manifestResponse.body && manifestResponse.body.error.code).toBe("export_manifest_hash_mismatch");
  });
});
