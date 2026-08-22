import type { AdminPrincipal, Env } from "@worker/env";

import { requireAnyCollectionRole, requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { nowIso } from "../lib/utils";

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
}

interface NoteExportRow {
  id: string;
  title: string;
  version: number;
  externalPath: string | null;
  r2Key: string;
  contentHash: string;
}

export async function createExportJob(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  includeHistory: boolean,
): Promise<ExportJobResult> {
  if (includeHistory) {
    await requireAnyCollectionRole(env, principal, collectionId, "admin");
  } else {
    await requireCollectionRole(env, principal, collectionId, "editor");
  }

  const notes = await env.DB.prepare(`
    SELECT n.id, n.title, n.version, n.external_path AS externalPath,
           n.content_hash AS contentHash, v.r2_key AS r2Key
    FROM notes n JOIN note_versions v ON v.note_id = n.id AND v.version = n.version
    WHERE n.collection_id = ? AND n.status != 'deleted'
    ORDER BY COALESCE(n.external_path, n.id)
  `).bind(collectionId).all<NoteExportRow>();

  const historyNotes = includeHistory ? (await env.DB.prepare(`
    SELECT n.id, n.version, n.content_hash AS contentHash, v.r2_key AS r2Key
    FROM note_versions v JOIN notes n ON n.id = v.note_id
    WHERE n.collection_id = ?
    ORDER BY n.id, v.version
  `).bind(collectionId).all<{ id: string; version: number; contentHash: string; r2Key: string }>()).results ?? [] : [];

  const manifest = {
    formatVersion: 1,
    kind: includeHistory ? "backup" as const : "portable" as const,
    createdAt: nowIso(),
    collectionId,
    includesHistory: includeHistory,
    notes: (notes.results ?? []).map((note) => ({
      id: note.id,
      path: note.externalPath ?? `${note.id}.md`,
      title: note.title,
      version: note.version,
      contentHash: note.contentHash,
    })),
  };

  const objects: ExportManifestObject[] = [];
  for (const note of notes.results ?? []) {
    const path = note.externalPath ?? `${note.id}.md`;
    objects.push({ logicalPath: `notes/${path}`, sha256: note.contentHash });
  }
  for (const version of historyNotes) {
    objects.push({ logicalPath: `history/${version.id}/${version.version}.md`, sha256: version.contentHash });
  }

  const manifestText = `${JSON.stringify({ ...manifest, objects }, null, 2)}\n`;
  const manifestHash = await sha256(manifestText);

  await writeAudit(env, {
    actorType: "user",
    actorId: principal.email,
    action: "export.create",
    resourceType: "collection",
    resourceId: collectionId,
    collectionIds: [collectionId],
    metadata: { kind: includeHistory ? "backup" : "portable", objectCount: objects.length },
  });

  return {
    id: crypto.randomUUID(),
    collectionId,
    kind: includeHistory ? "backup" : "portable",
    status: "completed",
    manifestHash,
    objects,
  };
}
