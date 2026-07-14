import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  createdBy: text("created_by").notNull(),
});

export const memberships = sqliteTable(
  "memberships",
  {
    collectionId: text("collection_id").notNull(),
    userEmail: text("user_email").notNull(),
    role: text("role", { enum: ["admin", "editor", "viewer"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.collectionId, table.userEmail] })],
);

export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id").notNull(),
    title: text("title").notNull(),
    tagsJson: text("tags_json").notNull().default("[]"),
    status: text("status", { enum: ["draft", "published", "deleted"] }).notNull(),
    version: integer("version").notNull(),
    indexedVersion: integer("indexed_version"),
    contentHash: text("content_hash").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("idx_notes_collection_updated").on(table.collectionId, table.updatedAt),
    index("idx_notes_status").on(table.status),
  ],
);

export const noteVersions = sqliteTable(
  "note_versions",
  {
    noteId: text("note_id").notNull(),
    version: integer("version").notNull(),
    r2Key: text("r2_key").notNull(),
    contentHash: text("content_hash").notNull(),
    title: text("title").notNull(),
    tagsJson: text("tags_json").notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [primaryKey({ columns: [table.noteId, table.version] })],
);

export const chunks = sqliteTable(
  "chunks",
  {
    id: text("id").primaryKey(),
    noteId: text("note_id").notNull(),
    collectionId: text("collection_id").notNull(),
    version: integer("version").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    headingPathJson: text("heading_path_json").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_chunks_note_version_ordinal").on(table.noteId, table.version, table.ordinal),
    index("idx_chunks_collection_version").on(table.collectionId, table.version),
  ],
);

export const indexJobs = sqliteTable(
  "index_jobs",
  {
    id: text("id").primaryKey(),
    noteId: text("note_id").notNull(),
    version: integer("version"),
    type: text("type", { enum: ["index", "delete"] }).notNull(),
    status: text("status", { enum: ["queued", "processing", "ready", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [index("idx_jobs_status_updated").on(table.status, table.updatedAt)],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    collectionIdsJson: text("collection_ids_json").notNull(),
    scopesJson: text("scopes_json").notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
    expiresAt: text("expires_at"),
    lastUsedAt: text("last_used_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [uniqueIndex("idx_api_tokens_hash").on(table.tokenHash)],
);

export const memoryProposals = sqliteTable(
  "memory_proposals",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id").notNull(),
    title: text("title").notNull(),
    tagsJson: text("tags_json").notNull(),
    source: text("source").notNull(),
    r2Key: text("r2_key").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
    submittedByTokenId: text("submitted_by_token_id").notNull(),
    createdAt: text("created_at").notNull(),
    reviewedAt: text("reviewed_at"),
    reviewedBy: text("reviewed_by"),
    reviewNote: text("review_note"),
    approvedNoteId: text("approved_note_id"),
    reviewLock: text("review_lock"),
    reviewLockedAt: text("review_locked_at"),
  },
  (table) => [index("idx_proposals_status_created").on(table.status, table.createdAt)],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type", { enum: ["user", "token", "system"] }).notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    collectionIdsJson: text("collection_ids_json").notNull().default("[]"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_audit_created").on(table.createdAt)],
);
