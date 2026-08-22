import type { AdminPrincipal, Env } from "@worker/env";

import { requireAnyCollectionRole, requireCollectionRole } from "../lib/auth";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { parseMarkdownDocument } from "../lib/markdown";
import { nowIso } from "../lib/utils";

const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

export interface ImportItemPlan {
  relativePath: string;
  action: "create" | "update" | "unchanged" | "conflict";
  targetNoteId: string | null;
  expectedVersion: number | null;
  contentHash: string;
}

export interface ImportPlanResult {
  collectionId: string;
  planVersion: number;
  items: ImportItemPlan[];
}

interface NoteImportRow {
  id: string;
  version: number;
  status: string;
  externalPath: string | null;
  syncBaseHash: string | null;
  contentHash: string;
}

export async function planImport(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  files: Array<{ relativePath: string; markdown: string }>,
): Promise<ImportPlanResult> {
  await requireCollectionRole(env, principal, collectionId, "editor");

  const existing = await env.DB.prepare(`
    SELECT id, version, status, external_path AS externalPath,
           sync_base_hash AS syncBaseHash, content_hash AS contentHash
    FROM notes WHERE collection_id = ? AND external_path IS NOT NULL AND status != 'deleted'
  `).bind(collectionId).all<NoteImportRow>();
  const byPath = new Map<string, NoteImportRow>();
  (existing.results ?? []).forEach((row) => {
    if (row.externalPath) byPath.set(row.externalPath, row);
  });

  const items: ImportItemPlan[] = [];
  for (const file of files) {
    const path = file.relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path.endsWith(".md") || path.includes("..")) continue;
    let markdown: string;
    try {
      markdown = new TextDecoder().decode(file.markdown as unknown as Uint8Array ?? new TextEncoder().encode(file.markdown));
    } catch {
      continue;
    }
    const normalized = markdown.replace(/\r\n/g, "\n");
    let parsed;
    try {
      parsed = parseMarkdownDocument(normalized);
    } catch {
      continue;
    }
    void parsed;
    const hash = await sha256(normalized);
    if (new TextEncoder().encode(normalized).byteLength > MAX_IMPORT_FILE_BYTES) continue;

    const match = byPath.get(path);
    if (!match) {
      items.push({ relativePath: path, action: "create", targetNoteId: null, expectedVersion: null, contentHash: hash });
    } else if (match.contentHash === hash && match.syncBaseHash === match.contentHash) {
      items.push({ relativePath: path, action: "unchanged", targetNoteId: match.id, expectedVersion: match.version, contentHash: hash });
    } else if (match.syncBaseHash === match.contentHash) {
      items.push({ relativePath: path, action: "update", targetNoteId: match.id, expectedVersion: match.version, contentHash: hash });
    } else {
      items.push({ relativePath: path, action: "conflict", targetNoteId: match.id, expectedVersion: match.version, contentHash: hash });
    }
  }

  return { collectionId, planVersion: Math.floor(Date.now() / 1000), items };
}
