import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { MAX_MARKDOWN_BYTES } from "@shared/contracts";
import type { Env, McpPrincipal } from "./env";
import { ApiError } from "./lib/errors";
import { proposalSchema, searchSchema } from "@shared/contracts";
import { isKnowledgeAdmin } from "./lib/principal";
import { createCollection, restoreCollection, trashCollection, updateCollection } from "./services/collections";
import {
  createNote,
  diffNoteVersions,
  deleteNote,
  getNoteVersionForMcp,
  listNotesForCollections,
  listVersions,
  readNoteForCollections,
  readNoteForMcpAdmin,
  readNoteVersion,
  restoreDeletedNote,
  reviewNote,
  restoreVersion,
  updateNote,
} from "./services/notes";
import { submitProposal } from "./services/proposals";
import { searchKnowledge } from "./services/search";
import { recordAdminFailure, recordAdminUsage, runAdminMutation } from "./services/tokenRisk";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function toolError(error: unknown) {
  if (!(error instanceof ApiError)) return null;
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }, null, 2),
    }],
    structuredContent: { error: { code: error.code, message: error.message, details: error.details } },
    isError: true,
  };
}

function requireScope(principal: McpPrincipal, scope: McpPrincipal["scopes"][number]) {
  if (!principal.scopes.includes(scope) && !isKnowledgeAdmin(principal)) {
    throw new ApiError(403, "scope_required", `Token 缺少 ${scope} 权限`);
  }
}

async function tracked<T>(
  env: Env,
  principal: McpPrincipal,
  category: "read" | "search" | "proposal",
  operation: () => Promise<T>,
) {
  try {
    const result = await operation();
    if (isKnowledgeAdmin(principal)) await recordAdminUsage(env, principal, category);
    return toolResult(result);
  } catch (error) {
    if (isKnowledgeAdmin(principal)) await recordAdminFailure(env, principal).catch(() => undefined);
    throw error;
  }
}

async function mutationResult<T>(
  env: Env,
  principal: McpPrincipal,
  operationId: string,
  toolName: string,
  input: unknown,
  operation: () => Promise<T>,
) {
  try {
    return toolResult(await runAdminMutation(env, principal, operationId, toolName, input, operation));
  } catch (error) {
    const response = toolError(error);
    if (response) return response;
    throw error;
  }
}

async function collectionIdsForToken(env: Env, principal: McpPrincipal): Promise<string[]> {
  if (isKnowledgeAdmin(principal)) {
    const result = await env.DB.prepare(
      "SELECT id FROM collections WHERE trashed_at IS NULL ORDER BY name",
    ).all<{ id: string }>();
    return result.results?.map((row) => row.id) ?? [];
  }
  if (principal.collectionIds.length === 0) return [];
  const placeholders = principal.collectionIds.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id FROM collections WHERE id IN (${placeholders}) AND trashed_at IS NULL ORDER BY name`,
  ).bind(...principal.collectionIds).all<{ id: string }>();
  return result.results?.map((row) => row.id) ?? [];
}

async function collectionsForToken(env: Env, principal: McpPrincipal) {
  const collectionIds = await collectionIdsForToken(env, principal);
  if (collectionIds.length === 0) return [];
  const placeholders = collectionIds.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id, name, description, updated_at FROM collections WHERE id IN (${placeholders}) AND trashed_at IS NULL ORDER BY name`,
  ).bind(...collectionIds).all();
  return result.results ?? [];
}

function createMcpServer(env: Env, principal: McpPrincipal): McpServer {
  const server = new McpServer({ name: "knowledge-core", version: "0.1.0" });

  server.registerTool(
    "search_knowledge",
    {
      title: "Search knowledge",
      description: "Search authorized Markdown knowledge bases and return cited source excerpts.",
      inputSchema: {
        query: z.string().min(1).max(2000),
        collection_ids: z.array(z.string().uuid()).max(10).optional(),
        tags: z.array(z.string().min(1).max(60)).max(20).optional(),
        limit: z.number().int().min(1).max(8).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, collection_ids, tags, limit }) => tracked(env, principal, "search", async () => {
      requireScope(principal, "knowledge:read");
      const allowedCollectionIds = await collectionIdsForToken(env, principal);
      if (allowedCollectionIds.length === 0 && !collection_ids?.length) return [];
      const input = searchSchema.parse({
        query,
        collectionIds: collection_ids?.length ? collection_ids : allowedCollectionIds,
        tags: tags ?? [],
        limit: limit ?? 8,
      });
      return searchKnowledge(env, input, allowedCollectionIds);
    }),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read the complete current Markdown for an authorized note.",
      inputSchema: { note_id: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ note_id }) => tracked(env, principal, "read", async () => {
      requireScope(principal, "knowledge:read");
      if (isKnowledgeAdmin(principal)) return readNoteForMcpAdmin(env, principal, note_id);
      return readNoteForCollections(env, await collectionIdsForToken(env, principal), note_id);
    }),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List recently updated published notes in authorized knowledge bases.",
      inputSchema: {
        collection_ids: z.array(z.string().uuid()).max(10).optional(),
        tags: z.array(z.string().min(1).max(60)).max(20).optional(),
        updated_after: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        include_drafts: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ collection_ids, tags, updated_after, limit, include_drafts }) => tracked(env, principal, "read", async () => {
      requireScope(principal, "knowledge:read");
      if (include_drafts && !isKnowledgeAdmin(principal)) {
        throw new ApiError(403, "scope_required", "读取草稿需要 knowledge:admin 权限");
      }
      const allowedCollectionIds = await collectionIdsForToken(env, principal);
      const requested = collection_ids?.length ? collection_ids : allowedCollectionIds;
      const authorized = requested.filter((id) => allowedCollectionIds.includes(id));
      return listNotesForCollections(env, authorized, {
        tags: tags ?? [],
        updatedAfter: updated_after,
        limit: limit ?? 100,
        includeDrafts: include_drafts ?? false,
      });
    }),
  );

  server.registerTool(
    "list_collections",
    {
      title: "List knowledge bases",
      description: "List knowledge bases authorized for this token.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => tracked(env, principal, "read", async () => {
      requireScope(principal, "knowledge:read");
      return collectionsForToken(env, principal);
    }),
  );

  server.registerTool(
    "list_recent_changes",
    {
      title: "List recent changes",
      description: "List published notes updated after an ISO timestamp.",
      inputSchema: {
        since: z.string().datetime(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ since, limit }) => tracked(env, principal, "read", async () => {
      requireScope(principal, "knowledge:read");
      const collectionIds = await collectionIdsForToken(env, principal);
      if (collectionIds.length === 0) return [];
      const placeholders = collectionIds.map(() => "?").join(",");
      const result = await env.DB.prepare(`
        SELECT id, collection_id, title, tags_json, version, updated_at, updated_by
        FROM notes WHERE collection_id IN (${placeholders}) AND status = 'published' AND updated_at > ?
        ORDER BY updated_at DESC LIMIT ?
      `).bind(...collectionIds, since, limit ?? 100).all();
      return result.results ?? [];
    }),
  );

  if (isKnowledgeAdmin(principal)) {
    server.registerTool(
      "create_collection",
      {
        title: "Create knowledge base",
        description: "Create a knowledge base. The administrator who issued this global token remains its human owner.",
        inputSchema: {
          operation_id: z.string().uuid(),
          name: z.string().trim().min(1).max(80),
          description: z.string().trim().max(500).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, name, description }) => mutationResult(env, principal, operation_id, "create_collection", { name, description: description ?? "" }, () => createCollection(env, principal, { name, description: description ?? "" })),
    );

    server.registerTool(
      "update_collection",
      {
        title: "Update knowledge base",
        description: "Rename or update a knowledge base using its last observed updated_at value for optimistic locking.",
        inputSchema: {
          operation_id: z.string().uuid(),
          collection_id: z.string().uuid(),
          expected_updated_at: z.string().datetime(),
          name: z.string().trim().min(1).max(80),
          description: z.string().trim().max(500),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, collection_id, expected_updated_at, name, description }) => mutationResult(
        env,
        principal,
        operation_id,
        "update_collection",
        { collection_id, expected_updated_at, name, description },
        () => updateCollection(env, principal, collection_id, expected_updated_at, { name, description }),
      ),
    );

    server.registerTool(
      "trash_collection",
      {
        title: "Move knowledge base to trash",
        description: "Hide a knowledge base from normal API and MCP access while preserving all Markdown, versions, members, tokens and proposals for recovery.",
        inputSchema: {
          operation_id: z.string().uuid(),
          collection_id: z.string().uuid(),
          expected_updated_at: z.string().datetime(),
          confirm_name: z.string().min(1).max(80),
          reason: z.string().trim().max(500).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, collection_id, expected_updated_at, confirm_name, reason }) => mutationResult(
        env,
        principal,
        operation_id,
        "trash_collection",
        { collection_id, expected_updated_at, confirm_name, reason: reason ?? "" },
        () => trashCollection(env, principal, collection_id, { expectedUpdatedAt: expected_updated_at, confirmationName: confirm_name, reason }),
      ),
    );

    server.registerTool(
      "delete_collection",
      {
        title: "Move knowledge base to trash (compatibility alias)",
        description: "Compatibility alias for trash_collection. This never physically deletes D1, R2, versions, members, tokens or proposals.",
        inputSchema: {
          operation_id: z.string().uuid(),
          collection_id: z.string().uuid(),
          expected_updated_at: z.string().datetime(),
          confirm_name: z.string().min(1).max(80),
          reason: z.string().trim().max(500).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, collection_id, expected_updated_at, confirm_name, reason }) => mutationResult(
        env,
        principal,
        operation_id,
        "delete_collection",
        { collection_id, expected_updated_at, confirm_name, reason: reason ?? "" },
        () => trashCollection(env, principal, collection_id, { expectedUpdatedAt: expected_updated_at, confirmationName: confirm_name, reason }),
      ),
    );

    server.registerTool(
      "restore_collection",
      {
        title: "Restore knowledge base from trash",
        description: "Restore a trashed knowledge base using the last observed trashed_at value.",
        inputSchema: {
          operation_id: z.string().uuid(),
          collection_id: z.string().uuid(),
          expected_trashed_at: z.string().datetime(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, collection_id, expected_trashed_at }) => mutationResult(
        env,
        principal,
        operation_id,
        "restore_collection",
        { collection_id, expected_trashed_at },
        () => restoreCollection(env, principal, collection_id, expected_trashed_at),
      ),
    );

    server.registerTool(
      "create_note",
      {
        title: "Create Markdown note",
        description: "Create a draft or published Markdown note in a knowledge base. YAML frontmatter is required.",
        inputSchema: {
          operation_id: z.string().uuid(),
          collection_id: z.string().uuid(),
          markdown: z.string().min(1).max(MAX_MARKDOWN_BYTES),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, collection_id, markdown }) => mutationResult(
        env,
        principal,
        operation_id,
        "create_note",
        { collection_id, markdown },
        () => createNote(env, principal, collection_id, markdown),
      ),
    );

    server.registerTool(
      "update_note",
      {
        title: "Update Markdown note",
        description: "Update Markdown using the last observed version for optimistic locking.",
        inputSchema: {
          operation_id: z.string().uuid(),
          note_id: z.string().uuid(),
          expected_version: z.number().int().positive(),
          markdown: z.string().min(1).max(MAX_MARKDOWN_BYTES),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, note_id, expected_version, markdown }) => mutationResult(
        env,
        principal,
        operation_id,
        "update_note",
        { note_id, expected_version, markdown },
        () => updateNote(env, principal, note_id, expected_version, markdown),
      ),
    );

    server.registerTool(
      "delete_note",
      {
        title: "Delete Markdown note",
        description: "Soft-delete a note after matching both its current version and exact title.",
        inputSchema: {
          operation_id: z.string().uuid(),
          note_id: z.string().uuid(),
          expected_version: z.number().int().positive(),
          confirm_title: z.string().min(1).max(160),
          reason: z.string().trim().max(500).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, note_id, expected_version, confirm_title, reason }) => mutationResult(
        env,
        principal,
        operation_id,
        "delete_note",
        { note_id, expected_version, confirm_title, reason: reason ?? "" },
        () => deleteNote(env, principal, note_id, { expectedVersion: expected_version, confirmationTitle: confirm_title, reason }),
      ),
    );

    server.registerTool(
      "restore_note",
      {
        title: "Restore Markdown note from trash",
        description: "Restore a soft-deleted note using its last observed version and deleted_at value.",
        inputSchema: {
          operation_id: z.string().uuid(),
          note_id: z.string().uuid(),
          expected_version: z.number().int().positive(),
          expected_deleted_at: z.string().datetime(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, note_id, expected_version, expected_deleted_at }) => mutationResult(
        env,
        principal,
        operation_id,
        "restore_note",
        { note_id, expected_version, expected_deleted_at },
        () => restoreDeletedNote(env, principal, note_id, { expectedVersion: expected_version, expectedDeletedAt: expected_deleted_at }),
      ),
    );

    server.registerTool(
      "list_note_versions",
      {
        title: "List note versions",
        description: "List all saved versions of a note, newest first. Read-only.",
        inputSchema: { note_id: z.string().uuid() },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ note_id }) => tracked(env, principal, "read", () => listVersions(env, principal, note_id)),
    );

    server.registerTool(
      "read_note_version",
      {
        title: "Read a historical note version",
        description: "Read the complete Markdown for a specific version of a note. Read-only.",
        inputSchema: {
          note_id: z.string().uuid(),
          version: z.number().int().positive(),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ note_id, version }) => tracked(env, principal, "read", () => readNoteVersion(env, principal, note_id, version)),
    );

    server.registerTool(
      "diff_note_versions",
      {
        title: "Diff two note versions",
        description: "Return line-level diff between two versions of a note. Read-only.",
        inputSchema: {
          note_id: z.string().uuid(),
          from_version: z.number().int().positive(),
          to_version: z.number().int().positive(),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ note_id, from_version, to_version }) => tracked(env, principal, "read", () => diffNoteVersions(env, principal, note_id, from_version, to_version)),
    );

    server.registerTool(
      "restore_note_version",
      {
        title: "Restore a historical note version",
        description: "Restore a previous version as a new version using optimistic locking on the current version.",
        inputSchema: {
          operation_id: z.string().uuid(),
          note_id: z.string().uuid(),
          expected_version: z.number().int().positive(),
          source_version: z.number().int().positive(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, note_id, expected_version, source_version }) => mutationResult(
        env,
        principal,
        operation_id,
        "restore_note_version",
        { note_id, expected_version, source_version },
        async () => {
          const current = await getNoteVersionForMcp(env, note_id);
          if (current.version !== expected_version) {
            throw new ApiError(409, "version_conflict", `文档已更新到版本 ${current.version}，请重新查看 Diff`);
          }
          return restoreVersion(env, principal, note_id, source_version);
        },
      ),
    );

    server.registerTool(
      "review_note",
      {
        title: "Review a note",
        description: "Record a human review timestamp and optional next review deadline for a note.",
        inputSchema: {
          operation_id: z.string().uuid(),
          note_id: z.string().uuid(),
          expected_version: z.number().int().positive(),
          review_after: z.string().datetime().nullable().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ operation_id, note_id, expected_version, review_after }) => mutationResult(
        env,
        principal,
        operation_id,
        "review_note",
        { note_id, expected_version, review_after: review_after ?? null },
        () => reviewNote(env, principal, note_id, expected_version, review_after ?? null),
      ),
    );
  }

  server.registerTool(
    "propose_memory",
    {
      title: "Propose memory",
      description: "Submit Markdown memory for human review. It is not searchable until approved.",
      inputSchema: {
        collection_id: z.string().uuid(),
        title: z.string().min(1).max(160),
        body: z.string().min(1).max(2 * 1024 * 1024),
        tags: z.array(z.string().min(1).max(60)).max(20).optional(),
        source: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ collection_id, title, body, tags, source }) => {
      const input = proposalSchema.parse({ collectionId: collection_id, title, body, tags: tags ?? [], source: source ?? "agent" });
      if (!isKnowledgeAdmin(principal)) return toolResult(await submitProposal(env, principal, input));
      return tracked(env, principal, "proposal", () => submitProposal(env, principal, input));
    },
  );

  server.registerResource(
    "knowledge-note",
    new ResourceTemplate("kb://collections/{collectionId}/notes/{noteId}", { list: undefined }),
    { title: "Knowledge note", description: "Current Markdown note", mimeType: "text/markdown" },
    async (uri, variables) => {
      requireScope(principal, "knowledge:read");
      const collectionId = String(variables.collectionId);
      const noteId = String(variables.noteId);
      const collectionIds = await collectionIdsForToken(env, principal);
      if (!collectionIds.includes(collectionId)) throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
      const note = isKnowledgeAdmin(principal)
        ? await readNoteForMcpAdmin(env, principal, noteId)
        : await readNoteForCollections(env, [collectionId], noteId);
      if (note.collectionId !== collectionId) {
        throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
      }
      return { contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: note.markdown }] };
    },
  );

  return server;
}

export async function handleMcpRequest(request: Request, env: Env, principal: McpPrincipal): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = createMcpServer(env, principal);
  await server.connect(transport);
  return transport.handleRequest(request);
}
