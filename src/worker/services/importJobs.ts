import type { AdminPrincipal, Env } from "@worker/env";

import { requireCollectionRole } from "../lib/auth";
import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { canonicalizeMarkdown, parseMarkdownDocument, serializeMarkdownDocument } from "../lib/markdown";

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
  reviewedAt: string | null;
}

export function normalizeImportPath(input: string): string {
  const path = input.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = path.split("/");
  if (
    !path
    || /^[A-Za-z]:/.test(input)
    || !path.toLowerCase().endsWith(".md")
    || path.includes("\0")
    || new TextEncoder().encode(path).byteLength > 512
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ApiError(422, "invalid_import_path", `导入路径无效：${input.slice(0, 120)}`);
  }
  return path;
}

export function prepareImportMarkdown(markdown: string): string {
  const parsed = parseMarkdownDocument(markdown.replace(/\r\n/g, "\n"));
  delete parsed.frontmatter.id;
  delete parsed.frontmatter.version;
  delete parsed.frontmatter.reviewed_at;
  return serializeMarkdownDocument(parsed);
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
           sync_base_hash AS syncBaseHash, content_hash AS contentHash,
           reviewed_at AS reviewedAt
    FROM notes WHERE collection_id = ? AND external_path IS NOT NULL
  `).bind(collectionId).all<NoteImportRow>();
  const byPath = new Map<string, NoteImportRow>();
  (existing.results ?? []).forEach((row) => {
    if (row.externalPath) byPath.set(row.externalPath, row);
  });

  const items: ImportItemPlan[] = [];
  const seenPaths = new Set<string>();
  for (const file of files) {
    const path = normalizeImportPath(file.relativePath);
    if (seenPaths.has(path)) {
      throw new ApiError(422, "duplicate_import_path", `导入批次包含重复路径：${path}`);
    }
    seenPaths.add(path);
    if (typeof file.markdown !== "string") {
      throw new ApiError(422, "invalid_import_file", "导入文件内容必须是 Markdown 文本");
    }
    const normalized = file.markdown.replace(/\r\n/g, "\n");
    if (new TextEncoder().encode(normalized).byteLength > MAX_IMPORT_FILE_BYTES) {
      throw new ApiError(413, "import_file_too_large", `导入文件超过 2 MiB：${path}`);
    }
    const prepared = prepareImportMarkdown(normalized);
    const hash = await sha256(normalized);

    const match = byPath.get(path);
    if (!match) {
      items.push({ relativePath: path, action: "create", targetNoteId: null, expectedVersion: null, contentHash: hash });
      continue;
    }
    if (match.status === "deleted") {
      items.push({ relativePath: path, action: "conflict", targetNoteId: match.id, expectedVersion: match.version, contentHash: hash });
      continue;
    }

    const candidate = canonicalizeMarkdown(prepared, {
      id: match.id,
      version: match.version,
      reviewedAt: match.reviewedAt,
    });
    const candidateHash = await sha256(candidate.markdown);
    if (match.contentHash === candidateHash) {
      items.push({ relativePath: path, action: "unchanged", targetNoteId: match.id, expectedVersion: match.version, contentHash: hash });
    } else if (match.syncBaseHash === match.contentHash) {
      items.push({ relativePath: path, action: "update", targetNoteId: match.id, expectedVersion: match.version, contentHash: hash });
    } else {
      items.push({ relativePath: path, action: "conflict", targetNoteId: match.id, expectedVersion: match.version, contentHash: hash });
    }
  }

  return { collectionId, planVersion: Math.floor(Date.now() / 1000), items };
}
