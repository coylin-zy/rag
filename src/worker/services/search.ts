import type { SearchInput, SearchResult } from "@shared/contracts";
import type { Env } from "@worker/env";

import { ApiError } from "../lib/errors";
import { embedTexts, rerank } from "../lib/models";
import { excerpt, parseJson, resourceUri } from "../lib/utils";

interface CandidateRow {
  id: string;
  note_id: string;
  collection_id: string;
  version: number;
  title: string;
  heading_path_json: string;
  content: string;
  updated_at: string;
  tags_json: string;
}

export function reciprocalRankFusion(rankings: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  }
  return scores;
}

function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

async function lexicalCandidates(env: Env, query: string, collectionIds: string[]): Promise<CandidateRow[]> {
  const placeholders = collectionIds.map(() => "?").join(",");
  const common = `
    SELECT c.id, c.note_id, c.collection_id, c.version, c.title, c.heading_path_json,
           c.content, n.updated_at, n.tags_json
    FROM chunks c
    JOIN notes n ON n.id = c.note_id AND n.indexed_version = c.version
  `;
  const isShort = [...query].length < 3;
  const statement = isShort
    ? env.DB.prepare(`${common} WHERE c.collection_id IN (${placeholders}) AND n.status = 'published' AND c.content LIKE ? ESCAPE '\\' ORDER BY n.updated_at DESC LIMIT 30`)
        .bind(...collectionIds, `%${query.replace(/[%_]/g, "\\$&")}%`)
    : env.DB.prepare(`
        SELECT c.id, c.note_id, c.collection_id, c.version, c.title, c.heading_path_json,
               c.content, n.updated_at, n.tags_json
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.chunk_id
        JOIN notes n ON n.id = c.note_id AND n.indexed_version = c.version
        WHERE chunks_fts MATCH ? AND c.collection_id IN (${placeholders}) AND n.status = 'published'
        ORDER BY bm25(chunks_fts) LIMIT 30
      `).bind(ftsPhrase(query), ...collectionIds);
  const result = await statement.all<CandidateRow>();
  return result.results ?? [];
}

async function denseCandidateIds(env: Env, query: string, collectionIds: string[]): Promise<string[]> {
  const [embedding] = await embedTexts(env, [query]);
  try {
    const result = await env.VECTOR_INDEX.query(embedding, {
      topK: 30,
      returnMetadata: "all",
      filter: { collection_id: { $in: collectionIds } },
    });
    return result.matches.map((match) => match.id);
  } catch {
    if (env.ENVIRONMENT === "development") return [];
    throw new ApiError(502, "vector_search_failed", "语义检索暂时不可用");
  }
}

async function hydrateCandidates(env: Env, ids: string[], collectionIds: string[]): Promise<CandidateRow[]> {
  if (ids.length === 0 || collectionIds.length === 0) return [];
  const idPlaceholders = ids.map(() => "?").join(",");
  const collectionPlaceholders = collectionIds.map(() => "?").join(",");
  const result = await env.DB.prepare(`
    SELECT c.id, c.note_id, c.collection_id, c.version, c.title, c.heading_path_json,
           c.content, n.updated_at, n.tags_json
    FROM chunks c
    JOIN notes n ON n.id = c.note_id AND n.indexed_version = c.version
    WHERE c.id IN (${idPlaceholders}) AND c.collection_id IN (${collectionPlaceholders})
      AND n.status = 'published'
  `).bind(...ids, ...collectionIds).all<CandidateRow>();
  return result.results ?? [];
}

export async function searchKnowledge(env: Env, input: SearchInput, allowedCollectionIds: string[]): Promise<SearchResult[]> {
  const collectionIds = input.collectionIds.filter((id) => allowedCollectionIds.includes(id));
  if (collectionIds.length === 0) throw new ApiError(403, "no_search_scope", "没有可检索的知识库");

  const [lexical, denseIds] = await Promise.all([
    lexicalCandidates(env, input.query, collectionIds),
    denseCandidateIds(env, input.query, collectionIds),
  ]);
  const dense = await hydrateCandidates(env, denseIds, collectionIds);
  const rows = new Map<string, CandidateRow>();
  lexical.forEach((row) => rows.set(row.id, row));
  dense.forEach((row) => rows.set(row.id, row));

  const scores = reciprocalRankFusion([lexical.map((row) => row.id), denseIds]);

  let candidates = [...rows.values()]
    .filter((row) => {
      if (input.tags.length === 0) return true;
      const tags = parseJson<string[]>(row.tags_json, []);
      return input.tags.every((tag) => tags.includes(tag));
    })
    .sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
    .slice(0, 20);

  const reranked = await rerank(env, input.query, candidates.map((row) => `${row.title}\n${row.content}`));
  if (reranked?.length) {
    const byIndex = candidates;
    candidates = reranked.map((item) => byIndex[item.index]).filter(Boolean);
    reranked.forEach((item) => {
      const row = byIndex[item.index];
      if (row) scores.set(row.id, item.score);
    });
  }

  return candidates.slice(0, input.limit).map((row) => ({
    chunkId: row.id,
    noteId: row.note_id,
    collectionId: row.collection_id,
    title: row.title,
    headingPath: parseJson<string[]>(row.heading_path_json, []),
    excerpt: excerpt(row.content),
    score: Number((scores.get(row.id) ?? 0).toFixed(6)),
    version: row.version,
    resourceUri: resourceUri(row.collection_id, row.note_id),
    updatedAt: row.updated_at,
  }));
}
