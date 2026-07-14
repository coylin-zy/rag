import type { Env } from "@worker/env";

import { ApiError } from "./errors";
import { sha256 } from "./crypto";

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

interface WorkersAiEmbeddingResponse {
  data?: number[][];
}

interface RerankResponse {
  results?: Array<{ index?: number; relevance_score?: number; score?: number }>;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function localEmbedding(text: string): Promise<number[]> {
  const digest = await sha256(text);
  const values = Array.from({ length: 1024 }, (_, index) => {
    const offset = (index * 2) % digest.length;
    return (Number.parseInt(digest.slice(offset, offset + 2), 16) / 127.5) - 1;
  });
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  if (env.EMBEDDING_BASE_URL && env.EMBEDDING_MODEL && env.EMBEDDING_API_KEY) {
    const response = await fetch(endpoint(env.EMBEDDING_BASE_URL, "embeddings"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.EMBEDDING_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: env.EMBEDDING_MODEL, input: texts, dimensions: 1024 }),
    });
    if (!response.ok) throw new ApiError(502, "embedding_failed", `Embedding 服务返回 ${response.status}`);

    const payload = (await response.json()) as EmbeddingResponse;
    const embeddings = payload.data?.map((item) => item.embedding ?? []) ?? [];
    if (embeddings.length !== texts.length || embeddings.some((item) => item.length !== 1024)) {
      throw new ApiError(502, "embedding_shape_invalid", "Embedding 服务返回的向量数量或维度不正确");
    }
    return embeddings;
  }

  if (env.ENVIRONMENT === "development") return Promise.all(texts.map(localEmbedding));
  if (!env.AI) throw new ApiError(503, "embedding_not_configured", "Embedding 服务尚未配置");

  const payload = await env.AI.run("@cf/baai/bge-m3", {
    text: texts,
    truncate_inputs: true,
  }) as WorkersAiEmbeddingResponse;
  const embeddings = payload.data ?? [];
  if (embeddings.length !== texts.length || embeddings.some((item) => item.length !== 1024)) {
    throw new ApiError(502, "embedding_shape_invalid", "Workers AI 返回的向量数量或维度不正确");
  }
  return embeddings;
}

export async function rerank(
  env: Env,
  query: string,
  documents: string[],
): Promise<Array<{ index: number; score: number }> | null> {
  if (!env.RERANK_BASE_URL || !env.RERANK_MODEL || !env.RERANK_API_KEY) return null;

  try {
    const response = await fetch(endpoint(env.RERANK_BASE_URL, "rerank"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RERANK_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: env.RERANK_MODEL, query, documents, top_n: Math.min(20, documents.length) }),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as RerankResponse;
    return (payload.results ?? [])
      .filter((item): item is { index: number; relevance_score?: number; score?: number } => typeof item.index === "number")
      .map((item) => ({ index: item.index, score: item.relevance_score ?? item.score ?? 0 }));
  } catch {
    return null;
  }
}
