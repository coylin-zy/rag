import { z } from "zod";

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const utf8Markdown = z.string().min(1).max(MAX_MARKDOWN_BYTES).refine(
  (value) => utf8ByteLength(value) <= MAX_MARKDOWN_BYTES,
  "UTF-8 内容不得超过 2 MiB",
);

export const roleSchema = z.enum(["admin", "editor", "viewer"]);
export const noteStatusSchema = z.enum(["draft", "published", "deleted"]);
export const jobStatusSchema = z.enum(["queued", "processing", "ready", "failed"]);

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
});

export const saveNoteSchema = z.object({
  markdown: utf8Markdown,
});

export const searchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  collectionIds: z.array(z.string().uuid()).min(1).max(10),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  limit: z.number().int().min(1).max(8).default(8),
});

export const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  collectionIds: z.array(z.string().uuid()).min(1).max(50),
  scopes: z.array(z.enum(["knowledge:read", "memory:propose"])).min(1),
  expiresAt: z.string().datetime().nullable().default(null),
});

export const proposalSchema = z.object({
  collectionId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  body: utf8Markdown,
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  source: z.string().trim().max(500).default("agent"),
});

export type Role = z.infer<typeof roleSchema>;
export type NoteStatus = z.infer<typeof noteStatusSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type SearchInput = z.infer<typeof searchSchema>;

export interface ApiEnvelope<T> {
  data: T;
  requestId: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
}

export interface CollectionSummary {
  id: string;
  name: string;
  description: string;
  role: Role;
  noteCount: number;
  updatedAt: string;
}

export interface NoteSummary {
  id: string;
  collectionId: string;
  title: string;
  tags: string[];
  status: NoteStatus;
  version: number;
  indexedVersion: number | null;
  updatedAt: string;
  updatedBy: string;
}

export interface SearchResult {
  chunkId: string;
  noteId: string;
  collectionId: string;
  title: string;
  headingPath: string[];
  excerpt: string;
  score: number;
  version: number;
  resourceUri: string;
  updatedAt: string;
}
