import type { AdminPrincipal, Env } from "@worker/env";

import { sha256 } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { canonicalizeMarkdown } from "../lib/markdown";
import { nowIso } from "../lib/utils";

import type { ImportItemPlan } from "./importJobs";
import { createNote, updateNote } from "./notes";

export interface ImportApplyResult {
  applied: number;
  skipped: number;
  conflicts: string[];
}

export async function applyImportPlan(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  plan: ImportItemPlan[],
  files: Array<{ relativePath: string; markdown: string }>,
): Promise<ImportApplyResult> {
  const fileMap = new Map(files.map((file) => [file.relativePath.replace(/\\/g, "/").replace(/^\/+/, ""), file.markdown]));
  let applied = 0;
  let skipped = 0;
  const conflicts: string[] = [];

  for (const item of plan) {
    if (item.action === "conflict") {
      conflicts.push(item.relativePath);
      skipped++;
      continue;
    }
    const markdown = fileMap.get(item.relativePath);
    if (!markdown && item.action !== "unchanged") {
      skipped++;
      continue;
    }
    try {
      if (item.action === "create" && markdown) {
        await createImportedNote(env, principal, collectionId, item.relativePath, markdown);
        applied++;
      } else if (item.action === "update" && markdown && item.targetNoteId && item.expectedVersion) {
        await updateImportedNote(env, principal, item.targetNoteId, item.expectedVersion, markdown);
        applied++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
      conflicts.push(item.relativePath);
    }
  }
  return { applied, skipped, conflicts };
}

async function createImportedNote(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  externalPath: string,
  markdownInput: string,
) {
  await env.DB.prepare("SELECT 1 FROM notes WHERE collection_id = ? AND external_path = ? LIMIT 1")
    .bind(collectionId, externalPath).first().then((row) => {
      if (row) throw new ApiError(409, "import_path_conflict", "导入路径已被占用");
    });
  return createNote(env, principal, collectionId, normalizeForCanonical(markdownInput));
}

async function updateImportedNote(
  env: Env,
  principal: AdminPrincipal,
  noteId: string,
  expectedVersion: number,
  markdownInput: string,
) {
  return updateNote(env, principal, noteId, expectedVersion, normalizeForCanonical(markdownInput));
}

function normalizeForCanonical(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n");
}
