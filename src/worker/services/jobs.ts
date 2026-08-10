import { and, asc, eq, inArray, lt } from "drizzle-orm";

import type { AdminPrincipal, Env, IndexQueueMessage, NewIndexQueueMessage } from "@worker/env";

import { createDb } from "../db/client";
import { indexJobs } from "../db/schema";
import { requireCollectionRole } from "../lib/auth";
import { writeAudit } from "../lib/audit";
import { ApiError } from "../lib/errors";
import { nowIso } from "../lib/utils";
import { listCollections } from "./collections";

export async function enqueueJob(env: Env, message: NewIndexQueueMessage): Promise<string> {
  const db = createDb(env.DB);
  const jobId = crypto.randomUUID();
  const now = nowIso();
  await db.insert(indexJobs).values({
    id: jobId,
    noteId: message.noteId,
    version: message.type === "index" ? message.version : null,
    type: message.type,
    status: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  });
  await env.INDEX_QUEUE.send({ ...message, jobId } as IndexQueueMessage);
  return jobId;
}

export async function listJobs(env: Env, limit = 100) {
  const db = createDb(env.DB);
  return db.select().from(indexJobs).orderBy(asc(indexJobs.status), indexJobs.updatedAt).limit(Math.min(limit, 200));
}

export async function listJobsForAdmin(env: Env, principal: AdminPrincipal, limit = 100) {
  const accessible = (await listCollections(env, principal)).filter((collection) => collection.role !== "viewer");
  if (accessible.length === 0) return [];
  const placeholders = accessible.map(() => "?").join(",");
  const result = await env.DB.prepare(`
    SELECT j.id, j.note_id AS noteId, j.version, j.type, j.status, j.attempts,
           j.last_error AS lastError, j.created_at AS createdAt, j.updated_at AS updatedAt,
           j.completed_at AS completedAt
    FROM index_jobs j
    JOIN notes n ON n.id = j.note_id
    WHERE n.collection_id IN (${placeholders})
    ORDER BY j.updated_at DESC LIMIT ?
  `).bind(...accessible.map((item) => item.id), Math.min(limit, 200)).all();
  return result.results ?? [];
}

export async function retryJob(env: Env, jobId: string, resetAttempts = false): Promise<void> {
  const db = createDb(env.DB);
  const job = await db.query.indexJobs.findFirst({ where: eq(indexJobs.id, jobId) });
  if (!job) return;
  await db.update(indexJobs).set({
    status: "queued",
    lastError: null,
    completedAt: null,
    updatedAt: nowIso(),
    ...(resetAttempts ? { attempts: 0 } : {}),
  }).where(eq(indexJobs.id, jobId));
  const message: IndexQueueMessage = job.type === "index"
    ? { type: "index", jobId, noteId: job.noteId, version: job.version ?? 1 }
    : { type: "delete", jobId, noteId: job.noteId };
  await env.INDEX_QUEUE.send(message);
}

export async function retryJobForAdmin(env: Env, principal: AdminPrincipal, jobId: string): Promise<void> {
  const job = await env.DB.prepare(`
    SELECT j.status, n.collection_id AS collectionId
    FROM index_jobs j
    JOIN notes n ON n.id = j.note_id
    WHERE j.id = ?
    LIMIT 1
  `).bind(jobId).first<{ status: string; collectionId: string }>();
  if (!job) throw new ApiError(404, "job_not_found", "索引任务不存在或无权访问");
  await requireCollectionRole(env, principal, job.collectionId, "editor");
  if (job.status !== "failed") throw new ApiError(409, "job_not_failed", "只有失败任务可以手动重试");
  await retryJob(env, jobId, true);
  await writeAudit(env, { actorType: "user", actorId: principal.email, action: "job.retry", resourceType: "index_job", resourceId: jobId, collectionIds: [job.collectionId] });
}

export async function recoverStaleJobs(env: Env): Promise<number> {
  const db = createDb(env.DB);
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const stale = await db
    .select()
    .from(indexJobs)
    .where(and(inArray(indexJobs.status, ["queued", "processing"]), lt(indexJobs.updatedAt, cutoff)))
    .limit(50);
  await Promise.all(stale.map((job) => retryJob(env, job.id)));
  return stale.length;
}
