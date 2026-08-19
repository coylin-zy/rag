import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  createdBy: text("created_by").notNull(),
  trashedAt: text("trashed_at"),
  trashedBy: text("trashed_by"),
  trashReason: text("trash_reason"),
  purgeAfter: text("purge_after"),
}, (table) => [index("idx_collections_trashed_updated").on(table.trashedAt, table.updatedAt)]);

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
    deletedFromStatus: text("deleted_from_status", { enum: ["draft", "published"] }),
    deletedBy: text("deleted_by"),
    deleteReason: text("delete_reason"),
  },
  (table) => [
    index("idx_notes_collection_updated").on(table.collectionId, table.updatedAt),
    index("idx_notes_status").on(table.status),
    index("idx_notes_collection_deleted").on(table.collectionId, table.deletedAt),
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
    maxRequestsPerMinute: integer("max_requests_per_minute").notNull().default(60),
    maxWritesPerHour: integer("max_writes_per_hour").notNull().default(30),
    lastIpPrefix: text("last_ip_prefix"),
    lastIpChangedAt: text("last_ip_changed_at"),
  },
  (table) => [uniqueIndex("idx_api_tokens_hash").on(table.tokenHash)],
);

export const tokenRateWindows = sqliteTable(
  "token_rate_windows",
  {
    tokenId: text("token_id").notNull(),
    windowKind: text("window_kind", { enum: ["request_minute", "write_hour"] }).notNull(),
    windowStart: text("window_start").notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.tokenId, table.windowKind, table.windowStart] }),
    index("idx_token_rate_windows_cleanup").on(table.windowStart),
  ],
);

export const tokenUsageDaily = sqliteTable(
  "token_usage_daily",
  {
    tokenId: text("token_id").notNull(),
    usageDate: text("usage_date").notNull(),
    requests: integer("requests").notNull().default(0),
    reads: integer("reads").notNull().default(0),
    searches: integer("searches").notNull().default(0),
    proposals: integer("proposals").notNull().default(0),
    writes: integer("writes").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    throttles: integer("throttles").notNull().default(0),
    lastUsedAt: text("last_used_at"),
  },
  (table) => [
    primaryKey({ columns: [table.tokenId, table.usageDate] }),
    index("idx_token_usage_daily_date").on(table.usageDate),
  ],
);

export const tokenMutationReceipts = sqliteTable(
  "token_mutation_receipts",
  {
    tokenId: text("token_id").notNull(),
    operationId: text("operation_id").notNull(),
    toolName: text("tool_name").notNull(),
    inputHash: text("input_hash").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed"] }).notNull(),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    failedAt: text("failed_at"),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tokenId, table.operationId] }),
    index("idx_token_mutation_receipts_cleanup").on(table.expiresAt),
  ],
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
