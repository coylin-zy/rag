import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import { MAX_MARKDOWN_BYTES } from "@shared/contracts";
import type { Env, McpPrincipal } from "./env";
import { ApiError } from "./lib/errors";
import { proposalSchema, searchSchema } from "@shared/contracts";
import { isKnowledgeAdmin } from "./lib/principal";
import { createCollection, deleteCollection, updateCollection } from "./services/collections";
import {
  createNote,
  deleteNote,
  listNotesForCollections,
  readNoteForCollections,
  readNoteForMcpAdmin,
  updateNote,
} from "./services/notes";
import { submitProposal } from "./services/proposals";
import { searchKnowledge } from "./services/search";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function requireScope(principal: McpPrincipal, scope: McpPrincipal["scopes"][number]) {
  if (!principal.scopes.includes(scope) && !isKnowledgeAdmin(principal)) {
    throw new ApiError(403, "scope_required", `Token 缺少 ${scope} 权限`);
  }
}

async function collectionIdsForToken(env: Env, principal: McpPrincipal): Promise<string[]> {
  if (!isKnowledgeAdmin(principal)) return principal.collectionIds;
  const result = await env.DB.prepare("SELECT id FROM collections ORDER BY name").all<{ id: string }>();
  return result.results?.map((row) => row.id) ?? [];
}

async function collectionsForToken(env: Env, principal: McpPrincipal) {
  const collectionIds = await collectionIdsForToken(env, principal);
  if (collectionIds.length === 0) return [];
  const placeholders = collectionIds.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id, name, description, updated_at FROM collections WHERE id IN (${placeholders}) ORDER BY name`,
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
    async ({ query, collection_ids, tags, limit }) => {
      requireScope(principal, "knowledge:read");
      const allowedCollectionIds = await collectionIdsForToken(env, principal);
      if (allowedCollectionIds.length === 0 && !collection_ids?.length) return toolResult([]);
      const input = searchSchema.parse({
        query,
        collectionIds: collection_ids?.length ? collection_ids : allowedCollectionIds,
        tags: tags ?? [],
        limit: limit ?? 8,
      });
      return toolResult(await searchKnowledge(env, input, allowedCollectionIds));
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read the complete current Markdown for an authorized note.",
      inputSchema: { note_id: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ note_id }) => {
      requireScope(principal, "knowledge:read");
      if (isKnowledgeAdmin(principal)) return toolResult(await readNoteForMcpAdmin(env, principal, note_id));
      return toolResult(await readNoteForCollections(env, principal.collectionIds, note_id));
    },
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
    async ({ collection_ids, tags, updated_after, limit, include_drafts }) => {
      requireScope(principal, "knowledge:read");
      if (include_drafts && !isKnowledgeAdmin(principal)) {
        throw new ApiError(403, "scope_required", "读取草稿需要 knowledge:admin 权限");
      }
      const allowedCollectionIds = await collectionIdsForToken(env, principal);
      const requested = collection_ids?.length ? collection_ids : allowedCollectionIds;
      const authorized = requested.filter((id) => allowedCollectionIds.includes(id));
      return toolResult(await listNotesForCollections(env, authorized, {
        tags: tags ?? [],
        updatedAfter: updated_after,
        limit: limit ?? 100,
        includeDrafts: include_drafts ?? false,
      }));
    },
  );

  server.registerTool(
    "list_collections",
    {
      title: "List knowledge bases",
      description: "List knowledge bases authorized for this token.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      requireScope(principal, "knowledge:read");
      return toolResult(await collectionsForToken(env, principal));
    },
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
    async ({ since, limit }) => {
      requireScope(principal, "knowledge:read");
      const collectionIds = await collectionIdsForToken(env, principal);
      if (collectionIds.length === 0) return toolResult([]);
      const placeholders = collectionIds.map(() => "?").join(",");
      const result = await env.DB.prepare(`
        SELECT id, collection_id, title, tags_json, version, updated_at, updated_by
        FROM notes WHERE collection_id IN (${placeholders}) AND status = 'published' AND updated_at > ?
        ORDER BY updated_at DESC LIMIT ?
      `).bind(...collectionIds, since, limit ?? 100).all();
      return toolResult(result.results ?? []);
    },
  );

  if (isKnowledgeAdmin(principal)) {
    server.registerTool(
      "create_collection",
      {
        title: "Create knowledge base",
        description: "Create a knowledge base. The administrator who issued this global token remains its human owner.",
        inputSchema: {
          name: z.string().trim().min(1).max(80),
          description: z.string().trim().max(500).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ name, description }) => toolResult(await createCollection(env, principal, { name, description: description ?? "" })),
    );

    server.registerTool(
      "update_collection",
      {
        title: "Update knowledge base",
        description: "Rename or update a knowledge base using its last observed updated_at value for optimistic locking.",
        inputSchema: {
          collection_id: z.string().uuid(),
          expected_updated_at: z.string().datetime(),
          name: z.string().trim().min(1).max(80),
          description: z.string().trim().max(500),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ collection_id, expected_updated_at, name, description }) => toolResult(await updateCollection(
        env,
        principal,
        collection_id,
        expected_updated_at,
        { name, description },
      )),
    );

    server.registerTool(
      "delete_collection",
      {
        title: "Delete knowledge base",
        description: "Permanently delete an empty knowledge base after exact-name confirmation. Active scoped tokens and pending proposals still block deletion.",
        inputSchema: {
          collection_id: z.string().uuid(),
          confirm_name: z.string().min(1).max(80),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ collection_id, confirm_name }) => toolResult(await deleteCollection(env, principal, collection_id, confirm_name)),
    );

    server.registerTool(
      "create_note",
      {
        title: "Create Markdown note",
        description: "Create a draft or published Markdown note in a knowledge base. YAML frontmatter is required.",
        inputSchema: {
          collection_id: z.string().uuid(),
          markdown: z.string().min(1).max(MAX_MARKDOWN_BYTES),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ collection_id, markdown }) => toolResult(await createNote(env, principal, collection_id, markdown)),
    );

    server.registerTool(
      "update_note",
      {
        title: "Update Markdown note",
        description: "Update Markdown using the last observed version for optimistic locking.",
        inputSchema: {
          note_id: z.string().uuid(),
          expected_version: z.number().int().positive(),
          markdown: z.string().min(1).max(MAX_MARKDOWN_BYTES),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ note_id, expected_version, markdown }) => toolResult(await updateNote(env, principal, note_id, expected_version, markdown)),
    );

    server.registerTool(
      "delete_note",
      {
        title: "Delete Markdown note",
        description: "Soft-delete a note after matching both its current version and exact title.",
        inputSchema: {
          note_id: z.string().uuid(),
          expected_version: z.number().int().positive(),
          confirm_title: z.string().min(1).max(160),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ note_id, expected_version, confirm_title }) => toolResult({
        jobId: await deleteNote(env, principal, note_id, { expectedVersion: expected_version, confirmationTitle: confirm_title }),
      }),
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
      return toolResult(await submitProposal(env, principal, input));
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
