import type { AdminPrincipal, Env } from "@worker/env";

import { ApiError } from "../lib/errors";

import { normalizeImportPath, planImport, prepareImportMarkdown, type ImportItemPlan } from "./importJobs";
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
  const freshPlan = await planImport(env, principal, collectionId, files);
  if (!samePlan(plan, freshPlan.items)) {
    throw new ApiError(409, "import_plan_stale", "导入计划或文件内容已经变化，请重新生成 Dry-Run 计划");
  }

  const fileMap = new Map(files.map((file) => [normalizeImportPath(file.relativePath), prepareImportMarkdown(file.markdown)]));
  let applied = 0;
  let skipped = 0;
  const conflicts: string[] = [];

  for (const item of freshPlan.items) {
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
        await updateImportedNote(env, principal, collectionId, item.targetNoteId, item.expectedVersion, markdown);
        applied++;
      } else {
        skipped++;
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 422)) {
        skipped++;
        conflicts.push(item.relativePath);
        continue;
      }
      throw error;
    }
  }
  return { applied, skipped, conflicts };
}

function samePlan(submitted: ImportItemPlan[], fresh: ImportItemPlan[]): boolean {
  if (submitted.length !== fresh.length) return false;
  return fresh.every((item, index) => {
    const candidate = submitted[index];
    return candidate?.relativePath === item.relativePath
      && candidate.action === item.action
      && candidate.targetNoteId === item.targetNoteId
      && candidate.expectedVersion === item.expectedVersion
      && candidate.contentHash === item.contentHash;
  });
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
  return createNote(env, principal, collectionId, markdownInput, { externalPath });
}

async function updateImportedNote(
  env: Env,
  principal: AdminPrincipal,
  collectionId: string,
  noteId: string,
  expectedVersion: number,
  markdownInput: string,
) {
  const row = await env.DB.prepare("SELECT collection_id AS collectionId, external_path AS externalPath FROM notes WHERE id = ?")
    .bind(noteId).first<{ collectionId: string; externalPath: string | null }>();
  if (!row || row.collectionId !== collectionId || row.externalPath === null) {
    throw new ApiError(409, "import_target_changed", "导入目标已变化，请重新生成计划");
  }
  return updateNote(env, principal, noteId, expectedVersion, markdownInput, { externalPath: row.externalPath });
}
