import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";

import type { ApiEnvelope } from "@shared/contracts";

import { app as baseApp } from "./apiVersioning";
import type { AppVariables, Env } from "./env";
import { adminAuth, authenticateMcpToken } from "./lib/auth";
import { ApiError, errorResponse } from "./lib/errors";
import { handleProvenanceAwareMcpRequest } from "./mcpProvenance";
import { listReviewDueForAdmin, reviewNote } from "./services/review";

type AppEnv = { Bindings: Env; Variables: AppVariables };

function ok<T>(c: Context<AppEnv>, data: T, status: 200 | 201 = 200) {
  const payload: ApiEnvelope<T> = { data, requestId: c.get("requestId") };
  return c.json(payload, status);
}

function expectedVersion(header: string | undefined): number {
  if (!header) throw new ApiError(400, "if_match_required", "复核文档必须提供 If-Match 当前版本");
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

const reviewSchema = z.object({
  nextReviewAfter: z.string().datetime().nullable().default(null),
});

export const app = new Hono<AppEnv>();
app.onError((error, c) => errorResponse(c, error));

app.use("/mcp", requestMetadata);
app.all("/mcp", async (c) => {
  const principal = await authenticateMcpToken(
    c.env,
    c.req.header("authorization"),
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for"),
  );
  return handleProvenanceAwareMcpRequest(c.req.raw, c.env, principal);
});

app.use("/api/v1/collections/:collectionId/review-due", requestMetadata);
app.use("/api/v1/collections/:collectionId/review-due", adminAuth());
app.get("/api/v1/collections/:collectionId/review-due", async (c) => {
  const limit = z.coerce.number().int().min(1).max(200).default(100).parse(c.req.query("limit"));
  return ok(c, await listReviewDueForAdmin(c.env, c.get("principal"), c.req.param("collectionId"), limit));
});

app.use("/api/v1/notes/:noteId/review", requestMetadata);
app.use("/api/v1/notes/:noteId/review", async (c, next) => {
  if (c.env.ENVIRONMENT === "production" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (!c.env.ADMIN_ORIGIN || c.req.header("origin") !== c.env.ADMIN_ORIGIN) {
      throw new ApiError(403, "invalid_origin", "管理请求来源无效");
    }
  }
  await next();
});
app.use("/api/v1/notes/:noteId/review", adminAuth());
app.post("/api/v1/notes/:noteId/review", async (c) => {
  const input = reviewSchema.parse(await c.req.json());
  const result = await reviewNote(
    c.env,
    c.get("principal"),
    c.req.param("noteId"),
    expectedVersion(c.req.header("if-match")),
    input.nextReviewAfter,
  );
  c.header("etag", `"${result.version}"`);
  return ok(c, result);
});

app.route("/", baseApp);
