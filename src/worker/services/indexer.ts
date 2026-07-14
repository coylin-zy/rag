import { and, eq, lt } from "drizzle-orm";

import type { Env, IndexQueueMessage } from "@worker/env";

import { createDb } from "../db/client";
import { chunks, indexJobs, notes, noteVersions } from "../db/schema";
import { writeAudit } from "../lib/audit";
import { chunkMarkdown } from "../lib/chunking";
import { sha256 } from "../lib/crypto";
import { ApiError, safeErrorSummary } from "../lib/errors";
import { embedTexts } from "../lib/models";
import { nowIso, parseJson } from "../lib/utils";

async function deleteFtsRows(env: Env, ids: string[]): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 80) {
    const batch = ids.slice(offset, offset + 80);
    if (batch.length === 0) continue;
    const placeholders = batch.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${placeholders})`).bind(...batch).run();
  }
}

async function deleteVectors(env: Env, ids: string[]): Promise<void> {
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    if (batch.length === 0) continue;
    try {
      await env.VECTOR_INDEX.deleteByIds(batch);
    } catch (error) {
      if (env.ENVIRONMENT !== "development") throw error;
    }
  }
}

async function upsertVectors(env: Env, vectors: VectorizeVector[]): Promise<void> {
  for (let offset = 0; offset < vectors.length; offset += 50) {
    const batch = vectors.slice(offset, offset + 50);
    try {
      await env.VECTOR_INDEX.upsert(batch);
    } catch (error) {
      if (env.ENVIRONMENT !== "development") throw error;
    }
  }
}

async function markJob(env: Env, jobId: string, values: Partial<typeof indexJobs.$inferInsert>) {
  const db = createDb(env.DB);
  await db.update(indexJobs).set({ ...values, updatedAt: nowIso() }).where(eq(indexJobs.id, jobId));
}

async function removeStaleChunks(env: Env, noteId: string, activeVersion: number): Promise<void> {
  const db = createDb(env.DB);
  const stale = await db
    .select({ id: chunks.id })
    .from(chunks)
    .where(and(eq(chunks.noteId, noteId), lt(chunks.version, activeVersion)));
  const staleIds = stale.map((row) => row.id);
  await deleteVectors(env, staleIds);
  await deleteFtsRows(env, staleIds);
  await db.delete(chunks).where(and(eq(chunks.noteId, noteId), lt(chunks.version, activeVersion)));
}

async function processIndex(env: Env, message: Extract<IndexQueueMessage, { type: "index" }>): Promise<void> {
  const db = createDb(env.DB);
  await env.DB.prepare(
    "UPDATE index_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?",
  ).bind(nowIso(), message.jobId).run();

  const note = await db.query.notes.findFirst({ where: eq(notes.id, message.noteId) });
  if (!note || note.status === "deleted" || note.version !== message.version) {
    await markJob(env, message.jobId, { status: "ready", completedAt: nowIso(), lastError: null });
    return;
  }

  const versionRow = await db.query.noteVersions.findFirst({
    where: and(eq(noteVersions.noteId, note.id), eq(noteVersions.version, message.version)),
  });
  if (!versionRow) throw new ApiError(404, "note_version_not_found", "索引任务找不到文档版本");
  const object = await env.NOTES.get(versionRow.r2Key);
  if (!object) throw new ApiError(503, "note_object_missing", "索引任务找不到 R2 文档对象");
  const markdown = await object.text();
  if (await sha256(markdown) !== versionRow.contentHash) {
    throw new ApiError(503, "note_hash_mismatch", "R2 文档内容与版本哈希不一致");
  }
  const generated = await chunkMarkdown({ noteId: note.id, version: message.version, title: note.title, markdown });

  // A redelivered or manually rebuilt active version can refresh vectors in place.
  // Keeping the D1/FTS rows intact prevents a temporary search outage.
  if (note.indexedVersion === message.version) {
    const activeChunks = await db
      .select()
      .from(chunks)
      .where(and(eq(chunks.noteId, note.id), eq(chunks.version, message.version)));
    if (activeChunks.length > 0) {
      const activeEmbeddings: number[][] = [];
      for (let offset = 0; offset < activeChunks.length; offset += 32) {
        const batch = activeChunks.slice(offset, offset + 32);
        activeEmbeddings.push(...(await embedTexts(env, batch.map((chunk) => [
          chunk.title,
          parseJson<string[]>(chunk.headingPathJson, []).join(" > "),
          chunk.content,
        ].filter(Boolean).join("\n")))));
      }
      await upsertVectors(env, activeChunks.map((chunk, index) => ({
        id: chunk.id,
        values: activeEmbeddings[index],
        metadata: {
          note_id: note.id,
          collection_id: note.collectionId,
          version: message.version,
          ordinal: chunk.ordinal,
        },
      })));
      await removeStaleChunks(env, note.id, message.version);
      await markJob(env, message.jobId, { status: "ready", completedAt: nowIso(), lastError: null });
      return;
    }
  }

  // Same-version vectors use deterministic IDs and are safe to overwrite on retry.
  const generatedIds = generated.map((item) => item.id);
  await deleteFtsRows(env, generatedIds);
  await db.delete(chunks).where(and(eq(chunks.noteId, note.id), eq(chunks.version, message.version)));

  const embeddings: number[][] = [];
  for (let offset = 0; offset < generated.length; offset += 32) {
    embeddings.push(...(await embedTexts(env, generated.slice(offset, offset + 32).map((item) => item.embeddingText))));
  }

  const createdAt = nowIso();
  for (let offset = 0; offset < generated.length; offset += 40) {
    const batch = generated.slice(offset, offset + 40);
    const statements: D1PreparedStatement[] = [];
    for (const item of batch) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO chunks (id, note_id, collection_id, version, ordinal, title, heading_path_json, content, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).bind(
          item.id,
          note.id,
          note.collectionId,
          message.version,
          item.ordinal,
          note.title,
          JSON.stringify(item.headingPath),
          item.content,
          item.contentHash,
          createdAt,
        ),
      );
      statements.push(
        env.DB.prepare("INSERT INTO chunks_fts (chunk_id, title, heading_path, content) VALUES (?, ?, ?, ?)").bind(
          item.id,
          note.title,
          item.headingPath.join(" > "),
          item.content,
        ),
      );
    }
    if (statements.length) await env.DB.batch(statements);
  }

  await upsertVectors(
    env,
    generated.map((item, index) => ({
      id: item.id,
      values: embeddings[index],
      metadata: {
        note_id: note.id,
        collection_id: note.collectionId,
        version: message.version,
        ordinal: item.ordinal,
      },
    })),
  );

  const activated = await env.DB.prepare(`
    UPDATE notes SET indexed_version = ?
    WHERE id = ? AND version = ? AND status != 'deleted'
  `).bind(message.version, note.id, message.version).run();
  if ((activated.meta.changes ?? 0) === 0) {
    const supersededIds = generated.map((item) => item.id);
    await deleteVectors(env, supersededIds);
    await deleteFtsRows(env, supersededIds);
    await db.delete(chunks).where(and(eq(chunks.noteId, note.id), eq(chunks.version, message.version)));
    await markJob(env, message.jobId, { status: "ready", completedAt: nowIso(), lastError: null });
    return;
  }

  await removeStaleChunks(env, note.id, message.version);

  await markJob(env, message.jobId, { status: "ready", completedAt: nowIso(), lastError: null });
  await writeAudit(env, {
    actorType: "system",
    actorId: "indexer",
    action: "note.index",
    resourceType: "note",
    resourceId: note.id,
    collectionIds: [note.collectionId],
    metadata: { version: message.version, chunks: generated.length },
  });
}

async function processDelete(env: Env, message: Extract<IndexQueueMessage, { type: "delete" }>): Promise<void> {
  const db = createDb(env.DB);
  await env.DB.prepare(
    "UPDATE index_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?",
  ).bind(nowIso(), message.jobId).run();
  const note = await db.query.notes.findFirst({ where: eq(notes.id, message.noteId) });
  if (note && note.status !== "deleted") {
    await markJob(env, message.jobId, { status: "ready", completedAt: nowIso(), lastError: null });
    return;
  }
  const rows = await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.noteId, message.noteId));
  const ids = rows.map((row) => row.id);
  await deleteVectors(env, ids);
  await deleteFtsRows(env, ids);
  await db.delete(chunks).where(eq(chunks.noteId, message.noteId));
  await db.update(notes).set({ indexedVersion: null }).where(eq(notes.id, message.noteId));
  await markJob(env, message.jobId, { status: "ready", completedAt: nowIso(), lastError: null });
  await writeAudit(env, { actorType: "system", actorId: "indexer", action: "note.deindex", resourceType: "note", resourceId: message.noteId, collectionIds: note ? [note.collectionId] : [] });
}

export async function processIndexMessage(env: Env, message: IndexQueueMessage): Promise<void> {
  try {
    if (message.type === "index") await processIndex(env, message);
    else await processDelete(env, message);
  } catch (error) {
    await markJob(env, message.jobId, {
      status: "failed",
      lastError: safeErrorSummary(error),
    });
    throw error;
  }
}

export async function handleIndexQueue(batch: MessageBatch<IndexQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processIndexMessage(env, message.body);
      message.ack();
    } catch {
      message.retry();
    }
  }
}
