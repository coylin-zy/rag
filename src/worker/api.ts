import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";

import {
  createCollectionSchema,
  createTokenSchema,
  roleSchema,
  saveNoteSchema,
  searchSchema,
  type ApiEnvelope,
} from "@shared/contracts";

import type { AppVariables, Env } from "./env";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_SECONDS,
  adminAuth,
  authenticateMcpToken,
  createAdminSession,
  requireCollectionRole,
  verifyLoginCredentials,
  verifyProxyAdmin,
} from "./lib/auth";
import { writeAudit } from "./lib/audit";
import { ApiError, errorResponse } from "./lib/errors";
import { createExportJob } from "./services/exportJobs";
import { handleMcpRequest } from "./mcp";
import { listAuditLogs } from "./services/audit";
import {
  createCollection,
  listCollections,
  listMembers,
  listTrashedCollections,
  removeMember,
  restoreCollection,
  trashCollection,
  upsertMember,
} from "./services/collections";
import { enqueueJob, listJobsForAdmin, retryJobForAdmin } from "./services/jobs";
import { applyImportPlan } from "./services/importApply";
import { planImport } from "./services/importJobs";
import {
  createNote,
  diffNoteVersions,
  deleteNote,
  listNotes,
  listTrashedNotes,
  listVersions,
  readNoteForAdmin,
  readNoteVersion,
  reindexNote,
  restoreDeletedNote,
  restoreVersion,
  reviewNote,
  updateNote,
} from "./services/notes";
import { listProposals, readProposal, reviewProposal } from "./services/proposals";
import { searchKnowledge } from "./services/search";
import {
  createToken,
  listTokens,
  revokeToken,
} from "./services/tokens";
import { getTokenUsage, revokeAllKnowledgeAdminTokens } from "./services/tokenRisk";

type AppEnv = { Bindings: Env; Variables: AppVariables };

function ok<T>(c: Context<AppEnv>, data: T, status: 200 | 201 = 200) {
  const payload: ApiEnvelope<T> = { data, requestId: c.get("requestId") };
  return c.json(payload, status);
}

function expectedVersion(header: string | undefined): number {
  if (!header) throw new ApiError(400, "if_match_required", "更新文档必须提供 If-Match 版本");
  const match = header.trim().match(/^(?:W\/)?"([1-9]\d*)"$/);
  if (!match) throw new ApiError(400, "invalid_if_match", "If-Match 必须是服务端返回的文档版本 ETag");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new ApiError(400, "invalid_if_match", "If-Match 文档版本无效");
  return value;
}

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  await next();
  c.header("x-request-id", requestId);
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "same-origin");
});

app.onError((error, c) => errorResponse(c, error));

app.get("/healthz", (c) => c.json({ status: "ok" }));

app.all("/mcp", async (c) => {
  const principal = await authenticateMcpToken(
    c.env,
    c.req.header("authorization"),
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for"),
  );
  return handleMcpRequest(c.req.raw, c.env, principal);
});

app.use("/api/v1/*", async (c, next) => {
  if (c.env.ENVIRONMENT === "production" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (!c.env.ADMIN_ORIGIN || c.req.header("origin") !== c.env.ADMIN_ORIGIN) {
      throw new ApiError(403, "invalid_origin", "管理请求来源无效");
    }
  }
  await next();
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(1024),
});

const trashCollectionSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  confirmName: z.string().min(1).max(80),
  reason: z.string().trim().max(500).default(""),
});

const restoreCollectionSchema = z.object({ expectedTrashedAt: z.string().datetime() });
const deleteNoteSchema = z.object({ reason: z.string().trim().max(500).default("") });
const restoreDeletedNoteSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedDeletedAt: z.string().datetime(),
});

app.post("/api/v1/auth/login", async (c) => {
  const input = loginSchema.parse(await c.req.json());
  if (!(c.env.ENVIRONMENT === "development" && c.env.DEV_AUTH_BYPASS === "true")) {
    await verifyProxyAdmin(c.env, c.req.header("x-knowledge-proxy-secret") ?? "", input.email);
  }
  const principal = await verifyLoginCredentials(c.env, input.email, input.password);
  const token = await createAdminSession(c.env, principal.email);
  setCookie(c, ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === "production",
    sameSite: "Strict",
    path: "/",
    maxAge: ADMIN_SESSION_TTL_SECONDS,
  });
  c.header("cache-control", "no-store");
  return ok(c, { principal });
});

app.post("/api/v1/auth/logout", async (c) => {
  if (!(c.env.ENVIRONMENT === "development" && c.env.DEV_AUTH_BYPASS === "true")) {
    await verifyProxyAdmin(c.env, c.req.header("x-knowledge-proxy-secret") ?? "", c.env.ADMIN_LOGIN_EMAIL);
  }
  setCookie(c, ADMIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: c.env.ENVIRONMENT === "production",
    sameSite: "Strict",
    path: "/",
    maxAge: 0,
  });
  c.header("cache-control", "no-store");
  return ok(c, { loggedOut: true });
});

app.use("/api/v1/*", adminAuth());

app.get("/api/v1/session", (c) => {
  c.header("cache-control", "no-store");
  return ok(c, { principal: c.get("principal") });
});
app.get("/api/v1/audit", async (c) => {
  const query = z.object({
    collectionId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }).parse(c.req.query());
  return ok(c, await listAuditLogs(c.env, c.get("principal"), query));
});

app.get("/api/v1/trash/collections", async (c) => ok(c, await listTrashedCollections(c.env, c.get("principal"))));
app.get("/api/v1/trash/notes", async (c) => {
  const { collectionId } = z.object({ collectionId: z.string().uuid() }).parse(c.req.query());
  return ok(c, await listTrashedNotes(c.env, c.get("principal"), collectionId));
});

app.get("/api/v1/collections", async (c) => ok(c, await listCollections(c.env, c.get("principal"))));
app.post("/api/v1/collections", async (c) => {
  const input = createCollectionSchema.parse(await c.req.json());
  return ok(c, await createCollection(c.env, c.get("principal"), input), 201);
});
app.post("/api/v1/collections/:collectionId/trash", async (c) => {
  const input = trashCollectionSchema.parse(await c.req.json());
  return ok(c, await trashCollection(c.env, c.get("principal"), c.req.param("collectionId"), {
    expectedUpdatedAt: input.expectedUpdatedAt,
    confirmationName: input.confirmName,
    reason: input.reason,
  }));
});
app.post("/api/v1/collections/:collectionId/restore", async (c) => {
  const input = restoreCollectionSchema.parse(await c.req.json());
  return ok(c, await restoreCollection(c.env, c.get("principal"), c.req.param("collectionId"), input.expectedTrashedAt));
});
app.delete("/api/v1/collections/:collectionId", async (c) => {
  const input = trashCollectionSchema.parse(await c.req.json().catch(() => ({})));
  return ok(c, await trashCollection(c.env, c.get("principal"), c.req.param("collectionId"), {
    expectedUpdatedAt: input.expectedUpdatedAt,
    confirmationName: input.confirmName,
    reason: input.reason,
  }));
});
app.get("/api/v1/collections/:collectionId/members", async (c) => ok(c, await listMembers(c.env, c.get("principal"), c.req.param("collectionId"))));
app.put("/api/v1/collections/:collectionId/members", async (c) => {
  const input = z.object({ email: z.string().email(), role: roleSchema }).parse(await c.req.json());
  return ok(c, await upsertMember(c.env, c.get("principal"), c.req.param("collectionId"), input));
});
app.delete("/api/v1/collections/:collectionId/members/:email", async (c) => {
  await removeMember(c.env, c.get("principal"), c.req.param("collectionId"), decodeURIComponent(c.req.param("email")));
  return ok(c, { removed: true });
});

app.get("/api/v1/collections/:collectionId/notes", async (c) => ok(c, await listNotes(c.env, c.get("principal"), c.req.param("collectionId"))));
app.post("/api/v1/collections/:collectionId/notes", async (c) => {
  const input = saveNoteSchema.parse(await c.req.json());
  return ok(c, await createNote(c.env, c.get("principal"), c.req.param("collectionId"), input.markdown), 201);
});
app.get("/api/v1/notes/:noteId", async (c) => {
  const note = await readNoteForAdmin(c.env, c.get("principal"), c.req.param("noteId"));
  c.header("etag", `"${note.version}"`);
  return ok(c, note);
});
app.put("/api/v1/notes/:noteId", async (c) => {
  const input = saveNoteSchema.parse(await c.req.json());
  const result = await updateNote(c.env, c.get("principal"), c.req.param("noteId"), expectedVersion(c.req.header("if-match")), input.markdown);
  c.header("etag", `"${result.version}"`);
  return ok(c, result);
});
app.delete("/api/v1/notes/:noteId", async (c) => {
  const input = deleteNoteSchema.parse(await c.req.json().catch(() => ({})));
  return ok(c, await deleteNote(c.env, c.get("principal"), c.req.param("noteId"), {
    expectedVersion: expectedVersion(c.req.header("if-match")),
    reason: input.reason,
  }));
});
app.post("/api/v1/notes/:noteId/restore-deleted", async (c) => {
  const input = restoreDeletedNoteSchema.parse(await c.req.json());
  return ok(c, await restoreDeletedNote(c.env, c.get("principal"), c.req.param("noteId"), input));
});
app.get("/api/v1/notes/:noteId/versions", async (c) => ok(c, await listVersions(c.env, c.get("principal"), c.req.param("noteId"))));
app.get("/api/v1/notes/:noteId/versions/:version", async (c) => {
  const version = z.coerce.number().int().positive().parse(c.req.param("version"));
  return ok(c, await readNoteVersion(c.env, c.get("principal"), c.req.param("noteId"), version));
});
app.get("/api/v1/notes/:noteId/diff", async (c) => {
  const input = z.object({
    from: z.coerce.number().int().positive(),
    to: z.coerce.number().int().positive(),
  }).parse(Object.fromEntries(new URL(c.req.url).searchParams));
  return ok(c, await diffNoteVersions(c.env, c.get("principal"), c.req.param("noteId"), input.from, input.to));
});
app.post("/api/v1/notes/:noteId/restore", async (c) => {
  const { version } = z.object({ version: z.number().int().positive() }).parse(await c.req.json());
  return ok(c, await restoreVersion(c.env, c.get("principal"), c.req.param("noteId"), version));
});
app.post("/api/v1/notes/:noteId/reindex", async (c) => ok(c, { jobId: await reindexNote(c.env, c.get("principal"), c.req.param("noteId")) }));
app.post("/api/v1/notes/:noteId/review", async (c) => {
  const input = z.object({
    expectedVersion: z.number().int().positive(),
    reviewAfter: z.string().datetime().nullable().optional(),
  }).parse(await c.req.json());
  return ok(c, await reviewNote(c.env, c.get("principal"), c.req.param("noteId"), input.expectedVersion, input.reviewAfter));
});

app.post("/api/v1/search", async (c) => {
  const input = searchSchema.parse(await c.req.json());
  await Promise.all(input.collectionIds.map((id) => requireCollectionRole(c.env, c.get("principal"), id, "viewer")));
  return ok(c, await searchKnowledge(c.env, input, input.collectionIds));
});

app.post("/api/v1/collections/:collectionId/export", async (c) => {
  const input = z.object({ includeHistory: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
  return ok(c, await createExportJob(c.env, c.get("principal"), c.req.param("collectionId"), input.includeHistory));
});

app.post("/api/v1/collections/:collectionId/import/plan", async (c) => {
  const collectionId = c.req.param("collectionId");
  const bodySchema = z.object({
    files: z.array(z.object({
      relativePath: z.string().max(2048),
      markdown: z.string().max(2 * 1024 * 1024),
    })).max(500),
  });
  const body = bodySchema.parse(await c.req.json());
  const files = body.files;
  return ok(c, await planImport(c.env, c.get("principal"), collectionId, files));
});

app.post("/api/v1/collections/:collectionId/import/apply", async (c) => {
  const collectionId = c.req.param("collectionId");
  const input = z.object({
    items: z.array(z.object({
      relativePath: z.string().max(2048),
      action: z.enum(["create", "update", "unchanged", "conflict"]),
      targetNoteId: z.string().uuid().nullable(),
      expectedVersion: z.number().int().positive().nullable(),
      contentHash: z.string(),
    })).max(500),
    files: z.array(z.object({ relativePath: z.string().max(2048), markdown: z.string() })).max(500),
  }).parse(await c.req.json());
  return ok(c, await applyImportPlan(c.env, c.get("principal"), collectionId, input.items, input.files));
});

app.get("/api/v1/proposals", async (c) => ok(c, await listProposals(c.env, c.get("principal"))));
app.get("/api/v1/proposals/:proposalId", async (c) => ok(c, await readProposal(c.env, c.get("principal"), c.req.param("proposalId"))));
app.post("/api/v1/proposals/:proposalId/review", async (c) => {
  const input = z.object({ decision: z.enum(["approved", "rejected"]), reviewNote: z.string().max(1000).default("") }).parse(await c.req.json());
  return ok(c, await reviewProposal(c.env, c.get("principal"), c.req.param("proposalId"), input.decision, input.reviewNote));
});

app.get("/api/v1/tokens", async (c) => ok(c, await listTokens(c.env, c.get("principal"))));
app.post("/api/v1/tokens", async (c) => {
  const input = createTokenSchema.parse(await c.req.json());
  return ok(c, await createToken(c.env, c.get("principal"), input), 201);
});
app.post("/api/v1/tokens/revoke-knowledge-admin", async (c) => {
  const principal = c.get("principal");
  if (!principal.bootstrapAdmin) throw new ApiError(403, "bootstrap_admin_required", "只有初始管理员可以紧急撤销最高权限 Token");
  return ok(c, { revokedCount: await revokeAllKnowledgeAdminTokens(c.env, principal.email) });
});
app.get("/api/v1/tokens/:tokenId/usage", async (c) => {
  const principal = c.get("principal");
  if (!principal.bootstrapAdmin) throw new ApiError(403, "bootstrap_admin_required", "只有初始管理员可以查看最高权限 Token 用量");
  const days = z.coerce.number().int().min(1).max(30).default(7).parse(c.req.query("days"));
  return ok(c, await getTokenUsage(c.env, c.req.param("tokenId"), days));
});
app.delete("/api/v1/tokens/:tokenId", async (c) => {
  await revokeToken(c.env, c.get("principal"), c.req.param("tokenId"));
  return ok(c, { revoked: true });
});

app.get("/api/v1/jobs", async (c) => ok(c, await listJobsForAdmin(c.env, c.get("principal"))));
app.post("/api/v1/jobs/:jobId/retry", async (c) => {
  await retryJobForAdmin(c.env, c.get("principal"), c.req.param("jobId"));
  return ok(c, { queued: true });
});

app.post("/api/v1/collections/:collectionId/reindex", async (c) => {
  const collectionId = c.req.param("collectionId");
  await requireCollectionRole(c.env, c.get("principal"), collectionId, "editor");
  const rows = await listNotes(c.env, c.get("principal"), collectionId);
  const jobIds = await Promise.all(rows.map((note) => enqueueJob(c.env, { type: "index", noteId: note.id, version: note.version })));
  await writeAudit(c.env, {
    actorType: "user",
    actorId: c.get("principal").email,
    action: "collection.reindex",
    resourceType: "collection",
    resourceId: collectionId,
    collectionIds: [collectionId],
    metadata: { queued: jobIds.length },
  });
  return ok(c, { queued: jobIds.length, jobIds });
});
