import { desc, eq, inArray } from "drizzle-orm";

import type { AdminPrincipal, Env, McpPrincipal } from "@worker/env";

import { createDb } from "../db/client";
import { memoryProposals } from "../db/schema";
import { requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { ApiError } from "../lib/errors";
import { assertMarkdownSize, parseMarkdownDocument, serializeMarkdownDocument } from "../lib/markdown";
import { nowIso, parseJson } from "../lib/utils";
import { listCollections } from "./collections";
import { createNote } from "./notes";

function proposalKey(collectionId: string, proposalId: string) {
  return `proposals/${collectionId}/${proposalId}.md`;
}

function publicProposal(row: typeof memoryProposals.$inferSelect) {
  return {
    id: row.id,
    collectionId: row.collectionId,
    title: row.title,
    tags: parseJson<string[]>(row.tagsJson, []),
    source: row.source,
    status: row.status,
    submittedByTokenId: row.submittedByTokenId,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    reviewNote: row.reviewNote,
    approvedNoteId: row.approvedNoteId,
  };
}

export async function submitProposal(
  env: Env,
  principal: McpPrincipal,
  input: { collectionId: string; title: string; body: string; tags: string[]; source: string },
) {
  if (!principal.scopes.includes("memory:propose")) throw new ApiError(403, "scope_required", "Token 缺少 memory:propose 权限");
  if (!principal.collectionIds.includes(input.collectionId)) throw new ApiError(403, "collection_forbidden", "Token 无权向该知识库提交记忆");

  const id = crypto.randomUUID();
  const key = proposalKey(input.collectionId, id);
  const markdown = serializeMarkdownDocument({
    frontmatter: { title: input.title, tags: input.tags, status: "draft" },
    body: input.body,
  });
  assertMarkdownSize(markdown);
  await env.NOTES.put(key, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  const now = nowIso();
  const db = createDb(env.DB);
  await db.insert(memoryProposals).values({
    id,
    collectionId: input.collectionId,
    title: input.title,
    tagsJson: JSON.stringify(input.tags),
    source: input.source,
    r2Key: key,
    status: "pending",
    submittedByTokenId: principal.tokenId,
    createdAt: now,
  });
  await writeAudit(env, { actorType: "token", actorId: principal.tokenId, action: "proposal.create", resourceType: "proposal", resourceId: id, collectionIds: [input.collectionId] });
  return { id, status: "pending", createdAt: now };
}

export async function listProposals(env: Env, principal: AdminPrincipal) {
  const accessible = (await listCollections(env, principal)).filter((collection) => collection.role === "admin");
  if (accessible.length === 0) return [];
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(memoryProposals)
    .where(inArray(memoryProposals.collectionId, accessible.map((item) => item.id)))
    .orderBy(desc(memoryProposals.createdAt))
    .limit(200);
  return rows.map(publicProposal);
}

export async function readProposal(env: Env, principal: AdminPrincipal, proposalId: string) {
  const db = createDb(env.DB);
  const proposal = await db.query.memoryProposals.findFirst({ where: eq(memoryProposals.id, proposalId) });
  if (!proposal) throw new ApiError(404, "proposal_not_found", "记忆提案不存在");
  await requireCollectionRole(env, principal, proposal.collectionId, "admin");
  const object = await env.NOTES.get(proposal.r2Key);
  if (!object) throw new ApiError(503, "proposal_object_missing", "R2 中缺少提案内容");
  return { ...publicProposal(proposal), markdown: await object.text() };
}

export async function reviewProposal(
  env: Env,
  principal: AdminPrincipal,
  proposalId: string,
  decision: "approved" | "rejected",
  reviewNote: string,
) {
  const db = createDb(env.DB);
  const proposal = await db.query.memoryProposals.findFirst({ where: eq(memoryProposals.id, proposalId) });
  if (!proposal) throw new ApiError(404, "proposal_not_found", "记忆提案不存在");
  await requireCollectionRole(env, principal, proposal.collectionId, "admin");
  if (proposal.status !== "pending") throw new ApiError(409, "proposal_already_reviewed", "该提案已经完成审核");

  const staleLockCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  await env.DB.prepare(`
    UPDATE memory_proposals SET review_lock = NULL, review_locked_at = NULL
    WHERE id = ? AND status = 'pending' AND review_locked_at < ?
  `).bind(proposalId, staleLockCutoff).run();
  const reviewLock = crypto.randomUUID();
  const claimed = await env.DB.prepare(`
    UPDATE memory_proposals SET review_lock = ?, review_locked_at = ?
    WHERE id = ? AND status = 'pending' AND review_lock IS NULL
  `).bind(reviewLock, nowIso(), proposalId).run();
  if ((claimed.meta.changes ?? 0) === 0) {
    throw new ApiError(409, "proposal_review_in_progress", "该提案正在被其他管理员审核");
  }

  let approvedNoteId: string | null = null;
  try {
    if (decision === "approved") {
      const object = await env.NOTES.get(proposal.r2Key);
      if (!object) throw new ApiError(503, "proposal_object_missing", "R2 中缺少提案内容");
      const parsed = parseMarkdownDocument(await object.text());
      const markdown = serializeMarkdownDocument({
        frontmatter: { title: parsed.frontmatter.title, tags: parsed.frontmatter.tags, status: "published" },
        body: parsed.body,
      });
      const note = await createNote(env, principal, proposal.collectionId, markdown);
      approvedNoteId = note.id;
    }

    const reviewedAt = nowIso();
    const finalized = await env.DB.prepare(`
      UPDATE memory_proposals
      SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?, approved_note_id = ?,
          review_lock = NULL, review_locked_at = NULL
      WHERE id = ? AND status = 'pending' AND review_lock = ?
    `).bind(decision, reviewedAt, principal.email, reviewNote, approvedNoteId, proposalId, reviewLock).run();
    if ((finalized.meta.changes ?? 0) === 0) throw new ApiError(409, "proposal_review_lost", "提案审核锁已失效");
    await writeAudit(env, { actorType: "user", actorId: principal.email, action: `proposal.${decision}`, resourceType: "proposal", resourceId: proposalId, collectionIds: [proposal.collectionId], metadata: { approvedNoteId } });
    return { id: proposalId, status: decision, approvedNoteId, reviewedAt };
  } catch (error) {
    await env.DB.prepare(`
      UPDATE memory_proposals SET review_lock = NULL, review_locked_at = NULL
      WHERE id = ? AND status = 'pending' AND review_lock = ?
    `).bind(proposalId, reviewLock).run();
    throw error;
  }
}
