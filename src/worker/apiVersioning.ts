import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";

import type { ApiEnvelope } from "@shared/contracts";

import { app as baseApp } from "./api";
import type { AppVariables, Env } from "./env";
import { adminAuth, authenticateMcpToken } from "./lib/auth";
import { ApiError, errorResponse } from "./lib/errors";
import { handleVersionAwareMcpRequest } from "./mcpVersioning";
import { readNoteVersion, restoreNoteVersion } from "./services/versionHistory";

type AppEnv = { Bindings: Env; Variables: AppVariables };

function ok<T>(c: Context<AppEnv>, data: T, status: 200 | 201 = 200) {
  const payload: ApiEnvelope<T> = { data, requestId: c.get("requestId") };
  return c.json(payload, status);
}

function expectedVersion(header: string | undefined): number {
  if (!header) throw new ApiError(400, "if_match_required", "回滚文档必须提供 If-Match 当前版本");
  const match = header.trim().match(/^(?:W\/)?"([1-9]\d*)"$/);
  if (!match) throw new ApiError(400, "invalid_if_match", "If-Match 必须是服务端返回的当前文档版本 ETag");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) throw new ApiError(400, "invalid_if_match", "If-Match 文档版本无效");
  return value;
}

const requestMetadata: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  await next();
  c.header("x-request-id", requestId);
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "same-origin");
};

export const app = new Hono<AppEnv>();
app.onError((error, c) => errorResponse(c, error));

app.use("/mcp", requestMetadata);
app.all("/mcp", async (c) => {
  const principal = await authenticateMcpToken(
    c.env,
    c.req.header("authorization"),
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for"),
  );
  return handleVersionAwareMcpRequest(c.req.raw, c.env, principal);
});

app.use("/api/v1/notes/:noteId/versions/:version", requestMetadata);
app.use("/api/v1/notes/:noteId/versions/:version", adminAuth());
app.get("/api/v1/notes/:noteId/versions/:version", async (c) => {
  const version = z.coerce.number().int().positive().parse(c.req.param("version"));
  const result = await readNoteVersion(c.env, c.get("principal"), c.req.param("noteId"), version);
  c.header("etag", `"${result.version}"`);
  c.header("cache-control", "no-store");
  return ok(c, result);
});

app.use("/api/v1/notes/:noteId/restore", requestMetadata);
app.use("/api/v1/notes/:noteId/restore", async (c, next) => {
  if (c.env.ENVIRONMENT === "production" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (!c.env.ADMIN_ORIGIN || c.req.header("origin") !== c.env.ADMIN_ORIGIN) {
      throw new ApiError(403, "invalid_origin", "管理请求来源无效");
    }
  }
  await next();
});
app.use("/api/v1/notes/:noteId/restore", adminAuth());
app.post("/api/v1/notes/:noteId/restore", async (c) => {
  const { version: sourceVersion } = z.object({ version: z.number().int().positive() }).parse(await c.req.json());
  const result = await restoreNoteVersion(
    c.env,
    c.get("principal"),
    c.req.param("noteId"),
    expectedVersion(c.req.header("if-match")),
    sourceVersion,
  );
  c.header("etag", `"${result.version}"`);
  return ok(c, result);
});

app.route("/", baseApp);
