import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "@worker/lib/crypto";
import type { IndexQueueMessage } from "@worker/env";

import { apiRequest, createCollection, createNote, jsonInit, queueSendResponse, workerFetch } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("management API, D1 and R2", () => {
  it("applies every migration including FTS, scoped audit and recycle-bin columns", async () => {
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
    const collectionColumns = await env.DB.prepare("PRAGMA table_info(collections)").all<{ name: string }>();
    expect(collectionColumns.results?.map((row) => row.name)).toEqual(expect.arrayContaining([
      "trashed_at",
      "trashed_by",
      "trash_reason",
      "purge_after",
    ]));
    const noteColumns = await env.DB.prepare("PRAGMA table_info(notes)").all<{ name: string }>();
    expect(noteColumns.results?.map((row) => row.name)).toEqual(expect.arrayContaining([
      "deleted_from_status",
      "deleted_by",
      "delete_reason",
    ]));
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

  it("reserves highest-permission Token creation and revocation for bootstrap administrators", async () => {
    const collection = await createCollection("Delegated token boundary");
    await apiRequest(
      `/api/v1/collections/${collection.id}/members`,
      jsonInit("PUT", { email: "delegated-admin@example.com", role: "admin" }),
    );

    const mixedScopes = await apiRequest(
      "/api/v1/tokens",
      jsonInit("POST", {
        name: "Invalid mixed token",
        collectionIds: [],
        scopes: ["knowledge:admin", "knowledge:read"],
        expiresAt: null,
      }),
    );
    expect(mixedScopes.response.status).toBe(422);

    const unscopedRead = await apiRequest(
      "/api/v1/tokens",
      jsonInit("POST", {
        name: "Invalid unscoped reader",
        collectionIds: [],
        scopes: ["knowledge:read"],
        expiresAt: null,
      }),
    );
    expect(unscopedRead.response.status).toBe(422);

    const delegatedCreate = await apiRequest(
      "/api/v1/tokens",
      jsonInit("POST", {
        name: "Delegated global token",
        collectionIds: [],
        scopes: ["knowledge:admin"],
        expiresAt: null,
      }),
      "delegated-admin@example.com",
    );
    expect(delegatedCreate.response.status).toBe(403);
    expect("error" in delegatedCreate.body && delegatedCreate.body.error.code).toBe("bootstrap_admin_required");

    const created = await apiRequest<{ id: string; collectionIds: string[]; scopes: string[] }>(
      "/api/v1/tokens",
      jsonInit("POST", {
        name: "Bootstrap global token",
        collectionIds: [collection.id],
        scopes: ["knowledge:admin"],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    expect(created.response.status).toBe(201);
    if (!("data" in created.body)) throw new Error("Highest-permission Token creation failed");
    const globalToken = created.body.data;
    expect(globalToken).toMatchObject({ collectionIds: [], scopes: ["knowledge:admin"] });

    const delegatedList = await apiRequest<Array<{ id: string }>>(
      "/api/v1/tokens",
      {},
      "delegated-admin@example.com",
    );
    expect("data" in delegatedList.body && delegatedList.body.data.some((token) => token.id === globalToken.id)).toBe(false);

    const delegatedRevoke = await apiRequest(
      `/api/v1/tokens/${globalToken.id}`,
      { method: "DELETE" },
      "delegated-admin@example.com",
    );
    expect(delegatedRevoke.response.status).toBe(403);
    expect("error" in delegatedRevoke.body && delegatedRevoke.body.error.code).toBe("bootstrap_admin_required");

    const stillActive = await env.DB.prepare("SELECT revoked_at AS revokedAt FROM api_tokens WHERE id = ?")
      .bind(globalToken.id)
      .first<{ revokedAt: string | null }>();
    expect(stillActive?.revokedAt).toBeNull();

    const bootstrapRevoke = await apiRequest(`/api/v1/tokens/${globalToken.id}`, { method: "DELETE" });
    expect(bootstrapRevoke.response.status).toBe(200);
  });

  it("moves notes and non-empty collections to a recoverable trash without deleting D1 or R2", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const missingTrash = await apiRequest(
      "/api/v1/collections/00000000-0000-4000-8000-000000000000/trash",
      jsonInit("POST", {
        expectedUpdatedAt: "2026-08-10T00:00:00.000Z",
        confirmName: "Missing",
        reason: "test",
      }),
    );
    expect(missingTrash.response.status).toBe(404);
    expect("error" in missingTrash.body && missingTrash.body.error.code).toBe("collection_not_found");

    const collection = await createCollection("Recoverable knowledge");
    await apiRequest(
      `/api/v1/collections/${collection.id}/members`,
      jsonInit("PUT", { email: "viewer-delete@example.com", role: "viewer" }),
    );

    const trashInput = {
      expectedUpdatedAt: collection.updatedAt,
      confirmName: collection.name,
      reason: "integration test",
    };
    const viewerTrash = await apiRequest(
      `/api/v1/collections/${collection.id}/trash`,
      jsonInit("POST", trashInput),
      "viewer-delete@example.com",
    );
    expect(viewerTrash.response.status).toBe(403);

    const outsiderTrash = await apiRequest(
      `/api/v1/collections/${collection.id}/trash`,
      jsonInit("POST", trashInput),
      "outsider-delete@example.com",
    );
    expect(outsiderTrash.response.status).toBe(404);

    const created = await createNote(collection.id, { title: "Temporary note", body: "Recover me safely" });

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

    const noteDelete = await apiRequest<{ deletedAt: string }>(
      `/api/v1/notes/${created.note.id}`,
      jsonInit("DELETE", { reason: "superseded" }, { "if-match": `"${created.note.version}"` }),
    );
    expect(noteDelete.response.status).toBe(200);
    if (!("data" in noteDelete.body)) throw new Error("Note trash failed");
    const deletedAt = noteDelete.body.data.deletedAt;
    expect((await apiRequest(`/api/v1/notes/${created.note.id}`)).response.status).toBe(404);
    const noteTrash = await apiRequest<Array<{ id: string; deletedFromStatus: string; deletedAt: string }>>(
      `/api/v1/trash/notes?collectionId=${collection.id}`,
    );
    expect("data" in noteTrash.body && noteTrash.body.data).toEqual([
      expect.objectContaining({ id: created.note.id, deletedFromStatus: "published", deletedAt }),
    ]);

    const trashed = await apiRequest<{ trashed: boolean; collectionId: string; trashedAt: string }>(
      `/api/v1/collections/${collection.id}/trash`,
      jsonInit("POST", trashInput),
    );
    expect(trashed.response.status).toBe(200);
    if (!("data" in trashed.body)) throw new Error("Collection trash failed");
    expect(trashed.body.data).toMatchObject({ trashed: true, collectionId: collection.id });

    const activeCollections = await apiRequest<Array<{ id: string }>>("/api/v1/collections");
    expect("data" in activeCollections.body && activeCollections.body.data.some((item) => item.id === collection.id)).toBe(false);
    const trashCollections = await apiRequest<Array<{ id: string; trashedAt: string; deletedNoteCount: number }>>("/api/v1/trash/collections");
    expect("data" in trashCollections.body && trashCollections.body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: collection.id, trashedAt: trashed.body.data.trashedAt, deletedNoteCount: 1 }),
    ]));

    expect(await env.DB.prepare("SELECT id FROM collections WHERE id = ?").bind(collection.id).first()).toEqual({ id: collection.id });
    expect(await env.DB.prepare("SELECT id FROM api_tokens WHERE id = ?").bind(token.body.data.id).first()).toEqual({ id: token.body.data.id });
    expect(await env.DB.prepare("SELECT role FROM memberships WHERE collection_id = ? AND user_email = ?")
      .bind(collection.id, "viewer-delete@example.com").first()).toEqual({ role: "viewer" });
    expect(await env.NOTES.get(`notes/${collection.id}/${created.note.id}/current.md`)).not.toBeNull();
    expect(await env.NOTES.get(`versions/${collection.id}/${created.note.id}/1.md`)).not.toBeNull();

    const restoredCollection = await apiRequest(
      `/api/v1/collections/${collection.id}/restore`,
      jsonInit("POST", { expectedTrashedAt: trashed.body.data.trashedAt }),
    );
    expect(restoredCollection.response.status).toBe(200);
    const restoredNote = await apiRequest(
      `/api/v1/notes/${created.note.id}/restore-deleted`,
      jsonInit("POST", { expectedVersion: created.note.version, expectedDeletedAt: deletedAt }),
    );
    expect(restoredNote.response.status).toBe(200);
    expect(await env.DB.prepare("SELECT status, deleted_at AS deletedAt FROM notes WHERE id = ?")
      .bind(created.note.id).first()).toEqual({ status: "published", deletedAt: null });

    const audit = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE resource_id IN (?, ?) ORDER BY action",
    ).bind(collection.id, created.note.id).all<{ action: string }>();
    expect(audit.results?.map((row) => row.action)).toEqual(expect.arrayContaining([
      "collection.restore",
      "collection.trash",
      "note.delete",
      "note.restore_deleted",
    ]));
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

  it("applies imports idempotently, updates the sync baseline and rejects stale plans", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Import planning");
    const markdown = "---\ntitle: Import create\ntags: []\nstatus: published\n---\n\nIMPORT-PLAN-MARKER";

    type PlanItem = {
      relativePath: string;
      action: "create" | "update" | "unchanged" | "conflict";
      targetNoteId: string | null;
      expectedVersion: number | null;
      contentHash: string;
    };
    const files = [{ relativePath: "docs/import-create.md", markdown }];
    const planned = await apiRequest<{ items: PlanItem[] }>(
      `/api/v1/collections/${collection.id}/import/plan`,
      jsonInit("POST", { files }),
    );
    expect(planned.response.status).toBe(200);
    if (!("data" in planned.body)) throw new Error("Missing import plan");
    expect(planned.body.data.items).toEqual([{
      relativePath: "docs/import-create.md",
      action: "create",
      targetNoteId: null,
      expectedVersion: null,
      contentHash: await sha256(markdown),
    }]);

    const applied = await apiRequest<{ applied: number; skipped: number; conflicts: string[] }>(
      `/api/v1/collections/${collection.id}/import/apply`,
      jsonInit("POST", { items: planned.body.data.items, files }),
    );
    expect(applied.response.status).toBe(200);
    expect("data" in applied.body && applied.body.data).toEqual({ applied: 1, skipped: 0, conflicts: [] });

    const imported = await env.DB.prepare(`
      SELECT id, version, external_path AS externalPath,
             content_hash AS contentHash, sync_base_hash AS syncBaseHash
      FROM notes WHERE collection_id = ? AND external_path = ?
    `).bind(collection.id, "docs/import-create.md").first<{
      id: string;
      version: number;
      externalPath: string;
      contentHash: string;
      syncBaseHash: string;
    }>();
    expect(imported).toMatchObject({ version: 1, externalPath: "docs/import-create.md" });
    expect(imported?.syncBaseHash).toBe(imported?.contentHash);

    const unchanged = await apiRequest<{ items: PlanItem[] }>(
      `/api/v1/collections/${collection.id}/import/plan`,
      jsonInit("POST", { files }),
    );
    expect("data" in unchanged.body && unchanged.body.data.items[0]).toMatchObject({
      action: "unchanged",
      targetNoteId: imported?.id,
      expectedVersion: 1,
    });

    const nextMarkdown = markdown.replace("IMPORT-PLAN-MARKER", "IMPORT-UPDATED-MARKER");
    const nextFiles = [{ relativePath: "docs/import-create.md", markdown: nextMarkdown }];
    const updatePlan = await apiRequest<{ items: PlanItem[] }>(
      `/api/v1/collections/${collection.id}/import/plan`,
      jsonInit("POST", { files: nextFiles }),
    );
    if (!("data" in updatePlan.body)) throw new Error("Missing update import plan");
    expect(updatePlan.body.data.items[0]).toMatchObject({ action: "update", expectedVersion: 1 });

    const staleApply = await apiRequest(
      `/api/v1/collections/${collection.id}/import/apply`,
      jsonInit("POST", {
        items: updatePlan.body.data.items.map((item) => ({ ...item, contentHash: "0".repeat(64) })),
        files: nextFiles,
      }),
    );
    expect(staleApply.response.status).toBe(409);
    expect("error" in staleApply.body && staleApply.body.error.code).toBe("import_plan_stale");

    const updated = await apiRequest<{ applied: number; skipped: number; conflicts: string[] }>(
      `/api/v1/collections/${collection.id}/import/apply`,
      jsonInit("POST", { items: updatePlan.body.data.items, files: nextFiles }),
    );
    expect("data" in updated.body && updated.body.data).toEqual({ applied: 1, skipped: 0, conflicts: [] });
    const updatedRow = await env.DB.prepare(`
      SELECT version, content_hash AS contentHash, sync_base_hash AS syncBaseHash
      FROM notes WHERE id = ?
    `).bind(imported?.id).first<{ version: number; contentHash: string; syncBaseHash: string }>();
    expect(updatedRow).toMatchObject({ version: 2 });
    expect(updatedRow?.syncBaseHash).toBe(updatedRow?.contentHash);

    const importedDetail = await apiRequest<{ markdown: string }>(`/api/v1/notes/${imported?.id}`);
    if (!("data" in importedDetail.body)) throw new Error("Missing imported note detail");
    await apiRequest(
      `/api/v1/notes/${imported?.id}`,
      jsonInit("PUT", {
        markdown: importedDetail.body.data.markdown.replace("IMPORT-UPDATED-MARKER", "LOCAL-EDIT-MARKER"),
      }, { "if-match": '"2"' }),
    );
    const conflictPlan = await apiRequest<{ items: PlanItem[] }>(
      `/api/v1/collections/${collection.id}/import/plan`,
      jsonInit("POST", {
        files: [{
          relativePath: "docs/import-create.md",
          markdown: nextMarkdown.replace("IMPORT-UPDATED-MARKER", "REMOTE-EDIT-MARKER"),
        }],
      }),
    );
    expect("data" in conflictPlan.body && conflictPlan.body.data.items[0]).toMatchObject({
      action: "conflict",
      expectedVersion: 3,
    });

    const invalidFiles = await apiRequest(
      `/api/v1/collections/${collection.id}/import/plan`,
      jsonInit("POST", { files: "bad" }),
    );
    expect(invalidFiles.response.status).toBe(422);
    expect("error" in invalidFiles.body && invalidFiles.body.error.code).toBe("validation_error");

    const invalidFile = await apiRequest(
      `/api/v1/collections/${collection.id}/import/plan`,
      jsonInit("POST", { files: [{ relativePath: "bad.md" }] }),
    );
    expect(invalidFile.response.status).toBe(422);
    expect("error" in invalidFile.body && invalidFile.body.error.code).toBe("validation_error");

    const traversalPath = await apiRequest(
      `/api/v1/collections/${collection.id}/import/plan`,
      jsonInit("POST", { files: [{ relativePath: "../outside.md", markdown }] }),
    );
    expect(traversalPath.response.status).toBe(422);
    expect("error" in traversalPath.body && traversalPath.body.error.code).toBe("invalid_import_path");

    const duplicatePaths = await apiRequest(
      `/api/v1/collections/${collection.id}/import/plan`,
      jsonInit("POST", { files: [files[0], files[0]] }),
    );
    expect(duplicatePaths.response.status).toBe(422);
    expect("error" in duplicatePaths.body && duplicatePaths.body.error.code).toBe("duplicate_import_path");
  });

  it("streams portable and historical ZIP exports with version-specific checksums", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Export archive");
    const markdown = "---\ntitle: Exported note\ntags: []\nstatus: published\n---\n\nEXPORT-V1";
    const files = [{ relativePath: "docs/exported.md", markdown }];
    const plan = await apiRequest<{ items: Array<Record<string, unknown>> }>(
      `/api/v1/collections/${collection.id}/import/plan`,
      jsonInit("POST", { files }),
    );
    if (!("data" in plan.body)) throw new Error("Missing export fixture plan");
    await apiRequest(
      `/api/v1/collections/${collection.id}/import/apply`,
      jsonInit("POST", { items: plan.body.data.items, files }),
    );
    const note = await env.DB.prepare("SELECT id FROM notes WHERE collection_id = ? AND external_path = ?")
      .bind(collection.id, "docs/exported.md").first<{ id: string }>();
    if (!note) throw new Error("Missing imported note");
    const detail = await apiRequest<{ markdown: string }>(`/api/v1/notes/${note.id}`);
    if (!("data" in detail.body)) throw new Error("Missing imported note detail");
    await apiRequest(
      `/api/v1/notes/${note.id}`,
      jsonInit("PUT", { markdown: detail.body.data.markdown.replace("EXPORT-V1", "EXPORT-V2") }, { "if-match": '"1"' }),
    );

    const prepared = await apiRequest<{
      downloadUrl: string;
      archiveName: string;
      objects: Array<{ logicalPath: string; sha256: string }>;
    }>(`/api/v1/collections/${collection.id}/export`, jsonInit("POST", { includeHistory: true }));
    expect(prepared.response.status).toBe(200);
    if (!("data" in prepared.body)) throw new Error("Missing export manifest");
    expect(prepared.body.data.archiveName).toMatch(/-backup\.zip$/);
    expect(prepared.body.data.objects.map((item) => item.logicalPath)).toEqual(expect.arrayContaining([
      "notes/docs/exported.md",
      `history/${note.id}/1.md`,
      `history/${note.id}/2.md`,
    ]));
    const historyHashes = prepared.body.data.objects
      .filter((item) => item.logicalPath.startsWith(`history/${note.id}/`))
      .map((item) => item.sha256);
    expect(new Set(historyHashes).size).toBe(2);

    const tamperedDownload = await workerFetch(
      prepared.body.data.downloadUrl.replace(/manifestHash=[a-f0-9]{64}/, `manifestHash=${"0".repeat(64)}`),
    );
    expect(tamperedDownload.status).toBe(409);
    expect((await tamperedDownload.json() as { error: { code: string } }).error.code).toBe("export_plan_stale");

    const archive = await workerFetch(prepared.body.data.downloadUrl);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/zip");
    expect(archive.headers.get("content-disposition")).toContain(prepared.body.data.archiveName);
    const bytes = new Uint8Array(await archive.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const archiveText = new TextDecoder().decode(bytes);
    expect(archiveText).toContain("manifest.json");
    expect(archiveText).toContain("notes/docs/exported.md");
    expect(archiveText).toContain(`history/${note.id}/1.md`);
    expect(archiveText).toContain("EXPORT-V1");
    expect(archiveText).toContain("EXPORT-V2");
  });

  it("records a review as a new immutable version with matching D1 and R2 metadata", async () => {
    vi.spyOn(env.INDEX_QUEUE, "send").mockResolvedValue(queueSendResponse());
    const collection = await createCollection("Review consistency");
    const created = await createNote(collection.id, { title: "Review me", body: "REVIEW-BODY" });
    const reviewAfter = "2026-12-01T00:00:00.000Z";
    const reviewed = await apiRequest<{ version: number; reviewedAt: string; reviewAfter: string }>(
      `/api/v1/notes/${created.note.id}/review`,
      jsonInit("POST", { expectedVersion: 1, reviewAfter }),
    );
    expect(reviewed.response.status).toBe(200);
    if (!("data" in reviewed.body)) throw new Error("Missing reviewed note");
    expect(reviewed.body.data).toMatchObject({ version: 2, reviewAfter });
    expect(Number.isNaN(Date.parse(reviewed.body.data.reviewedAt))).toBe(false);

    const detail = await apiRequest<{ markdown: string; version: number }>(`/api/v1/notes/${created.note.id}`);
    if (!("data" in detail.body)) throw new Error("Missing reviewed note detail");
    expect(detail.body.data.version).toBe(2);
    expect(detail.body.data.markdown).toContain("review_after:");
    expect(detail.body.data.markdown).toContain(reviewAfter);
    expect(detail.body.data.markdown).toContain("reviewed_at:");
    expect(detail.body.data.markdown).toContain(reviewed.body.data.reviewedAt);
    const versionOne = await env.NOTES.get(`versions/${collection.id}/${created.note.id}/1.md`);
    const versionTwo = await env.NOTES.get(`versions/${collection.id}/${created.note.id}/2.md`);
    expect(await versionOne?.text()).not.toContain("reviewed_at:");
    expect(await versionTwo?.text()).toBe(detail.body.data.markdown);
    const row = await env.DB.prepare("SELECT content_hash AS contentHash FROM notes WHERE id = ?")
      .bind(created.note.id).first<{ contentHash: string }>();
    expect(versionTwo?.customMetadata?.sha256).toBe(row?.contentHash);
    const audit = await env.DB.prepare("SELECT action FROM audit_logs WHERE resource_id = ? AND action = 'note.review'")
      .bind(created.note.id).first<{ action: string }>();
    expect(audit).toEqual({ action: "note.review" });
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
