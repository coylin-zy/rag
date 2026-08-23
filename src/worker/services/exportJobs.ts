import type { AdminPrincipal, Env } from "@worker/env";

import { requireAnyCollectionRole, requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { nowIso } from "../lib/utils";
import { createZipStream, streamText, type ZipEntry } from "../lib/zip";

export interface ExportManifestObject {
  logicalPath: string;
  sha256: string;
}

export interface ExportJobResult {
  id: string;
  collectionId: string;
  kind: "portable" | "backup";
  status: "completed";
  manifestHash: string;
  objects: ExportManifestObject[];
  archiveName: string;
  downloadUrl: string;
}

interface NoteExportRow {
  id: string;
  title: string;
  version: number;
  externalPath: string | null;
  r2Key: string;
  contentHash: string;
}

interface HistoryExportRow {
  id: string;
  version: number;
  r2Key: string;
  contentHash: string;
}

interface ExportSource extends ExportManifestObject {
  r2Key: string;
}

interface ExportPlan {
  result: ExportJobResult;
  manifestText: string;
  sources: ExportSource[];
  createdAt: string;
}

export async function createExportJob(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  includeHistory: boolean,
): Promise<ExportJobResult> {
  const plan = await buildExportPlan(env, principal, collectionId, includeHistory);
  await writeExportAudit(env, principal, collectionId, "export.prepare", plan.result);
  return plan.result;
}

export async function createExportArchive(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  includeHistory: boolean,
  createdAt: string,
  expectedManifestHash: string,
): Promise<{ result: ExportJobResult; readable: ReadableStream<Uint8Array>; completed: Promise<void> }> {
  const plan = await buildExportPlan(env, principal, collectionId, includeHistory, createdAt);
  if (plan.result.manifestHash !== expectedManifestHash) {
    throw new ApiError(409, "export_plan_stale", "知识库在导出准备后发生了变化，请重新发起导出");
  }
  const entries: ZipEntry[] = [
    { name: "manifest.json", open: async () => streamText(plan.manifestText) },
    ...plan.sources.map((source) => ({
      name: source.logicalPath,
      open: async () => {
        const object = await env.NOTES.get(source.r2Key);
        if (!object) throw new ApiError(503, "export_object_missing", `导出对象缺失：${source.logicalPath}`);
        if (object.customMetadata?.sha256 !== source.sha256) {
          throw new ApiError(503, "export_object_hash_mismatch", `导出对象校验信息不一致：${source.logicalPath}`);
        }
        return object.body;
      },
    })),
  ];
  await writeExportAudit(env, principal, collectionId, "export.download", plan.result);
  const archive = createZipStream(entries, new Date(plan.createdAt));
  return { result: plan.result, ...archive };
}

async function buildExportPlan(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  includeHistory: boolean,
  requestedCreatedAt?: string,
): Promise<ExportPlan> {
  if (includeHistory) {
    await requireAnyCollectionRole(env, principal, collectionId, "admin");
  } else {
    await requireCollectionRole(env, principal, collectionId, "editor");
  }

  const notes = await env.DB.prepare(`
    SELECT n.id, n.title, n.version, n.external_path AS externalPath,
           v.content_hash AS contentHash, v.r2_key AS r2Key
    FROM notes n JOIN note_versions v ON v.note_id = n.id AND v.version = n.version
    WHERE n.collection_id = ? AND n.status != 'deleted'
    ORDER BY COALESCE(n.external_path, n.id)
  `).bind(collectionId).all<NoteExportRow>();

  const history = includeHistory ? (await env.DB.prepare(`
    SELECT n.id, v.version, v.content_hash AS contentHash, v.r2_key AS r2Key
    FROM note_versions v JOIN notes n ON n.id = v.note_id
    WHERE n.collection_id = ?
    ORDER BY n.id, v.version
  `).bind(collectionId).all<HistoryExportRow>()).results ?? [] : [];

  const sources: ExportSource[] = [];
  for (const note of notes.results ?? []) {
    const path = safeExportPath(note.externalPath, `${note.id}.md`);
    sources.push({ logicalPath: `notes/${path}`, sha256: note.contentHash, r2Key: note.r2Key });
  }
  for (const version of history) {
    sources.push({
      logicalPath: `history/${version.id}/${version.version}.md`,
      sha256: version.contentHash,
      r2Key: version.r2Key,
    });
  }

  const createdAt = requestedCreatedAt ?? nowIso();
  const kind = includeHistory ? "backup" as const : "portable" as const;
  const objects = sources.map(({ logicalPath, sha256: checksum }) => ({ logicalPath, sha256: checksum }));
  const manifest = {
    formatVersion: 1,
    kind,
    createdAt,
    collectionId,
    includesHistory: includeHistory,
    notes: (notes.results ?? []).map((note) => ({
      id: note.id,
      path: safeExportPath(note.externalPath, `${note.id}.md`),
      title: note.title,
      version: note.version,
      contentHash: note.contentHash,
    })),
    objects,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const archiveName = `knowledge-core-${collectionId}-${kind}.zip`;
  const manifestHash = await sha256(manifestText);
  const downloadUrl = `/api/v1/collections/${collectionId}/export/archive?includeHistory=${includeHistory ? "true" : "false"}&createdAt=${encodeURIComponent(createdAt)}&manifestHash=${manifestHash}`;
  const result: ExportJobResult = {
    id: crypto.randomUUID(),
    collectionId,
    kind,
    status: "completed",
    manifestHash,
    objects,
    archiveName,
    downloadUrl,
  };
  return { result, manifestText, sources, createdAt };
}

function safeExportPath(path: string | null, fallback: string): string {
  if (!path) return fallback;
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (!normalized || normalized.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return fallback;
  }
  return normalized;
}

async function writeExportAudit(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  action: "export.prepare" | "export.download",
  result: ExportJobResult,
) {
  await writeAudit(env, {
    actorType: "user",
    actorId: principal.email,
    action,
    resourceType: "collection",
    resourceId: collectionId,
    collectionIds: [collectionId],
    metadata: { kind: result.kind, objectCount: result.objects.length, manifestHash: result.manifestHash },
  });
}
