import type { TokenScope } from "@shared/contracts";

export interface Env {
  AI: Ai;
  DB: D1Database;
  NOTES: R2Bucket;
  VECTOR_INDEX: VectorizeIndex;
  INDEX_QUEUE: Queue<IndexQueueMessage>;
  ENVIRONMENT: string;
  DEV_AUTH_BYPASS: string;
  BOOTSTRAP_ADMIN_EMAILS: string;
  ADMIN_PROXY_SECRET: string;
  ADMIN_LOGIN_EMAIL: string;
  ADMIN_LOGIN_PASSWORD_HASH: string;
  ADMIN_SESSION_SECRET: string;
  ADMIN_ORIGIN: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  EMBEDDING_BASE_URL: string;
  EMBEDDING_API_KEY: string;
  EMBEDDING_MODEL: string;
  RERANK_BASE_URL: string;
  RERANK_API_KEY: string;
  RERANK_MODEL: string;
}

export type IndexQueueMessage =
  | { type: "index"; jobId: string; noteId: string; version: number }
  | { type: "delete"; jobId: string; noteId: string };

export type NewIndexQueueMessage =
  | { type: "index"; noteId: string; version: number }
  | { type: "delete"; noteId: string };

export interface AppVariables {
  requestId: string;
  principal: AdminPrincipal;
}

export interface AdminPrincipal {
  email: string;
  subject: string;
  bootstrapAdmin: boolean;
}

export interface McpPrincipal {
  tokenId: string;
  name: string;
  createdBy: string;
  collectionIds: string[];
  scopes: TokenScope[];
}

export type KnowledgePrincipal = AdminPrincipal | McpPrincipal;
