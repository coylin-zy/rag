import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import type { Env, McpPrincipal } from "./env";
import { ApiError } from "./lib/errors";
import { proposalSchema, searchSchema } from "@shared/contracts";
import { listNotesForCollections, readNoteForCollections } from "./services/notes";
import { submitProposal } from "./services/proposals";
import { searchKnowledge } from "./services/search";

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}

function requireScope(principal: McpPrincipal, scope: McpPrincipal["scopes"][number]) {
  if (!principal.scopes.includes(scope)) throw new ApiError(403, "scope_required", `Token 缺少 ${scope} 权限`);
}

async function collectionsForToken(env: Env, principal: McpPrincipal) {
  if (principal.collectionIds.length === 0) return [];
  const placeholders = principal.collectionIds.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT id, name, description, updated_at FROM collections WHERE id IN (${placeholders}) ORDER BY name`,
  ).bind(...principal.collectionIds).all();
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
      const input = searchSchema.parse({
        query,
        collectionIds: collection_ids?.length ? collection_ids : principal.collectionIds,
        tags: tags ?? [],
        limit: limit ?? 8,
      });
      return toolResult(await searchKnowledge(env, input, principal.collectionIds));
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
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ collection_ids, tags, updated_after, limit }) => {
      requireScope(principal, "knowledge:read");
      const requested = collection_ids?.length ? collection_ids : principal.collectionIds;
      const authorized = requested.filter((id) => principal.collectionIds.includes(id));
      return toolResult(await listNotesForCollections(env, authorized, {
        tags: tags ?? [],
        updatedAfter: updated_after,
        limit: limit ?? 100,
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
      if (principal.collectionIds.length === 0) return toolResult([]);
      const placeholders = principal.collectionIds.map(() => "?").join(",");
      const result = await env.DB.prepare(`
        SELECT id, collection_id, title, tags_json, version, updated_at, updated_by
        FROM notes WHERE collection_id IN (${placeholders}) AND status = 'published' AND updated_at > ?
        ORDER BY updated_at DESC LIMIT ?
      `).bind(...principal.collectionIds, since, limit ?? 100).all();
      return toolResult(result.results ?? []);
    },
  );

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
      if (!principal.collectionIds.includes(collectionId)) throw new ApiError(404, "note_not_found", "文档不存在或无权访问");
      const note = await readNoteForCollections(env, [collectionId], noteId);
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
