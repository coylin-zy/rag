import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";

import type { ApiEnvelope } from "@shared/contracts";

import { app as baseApp } from "./apiProvenance";
import type { AppVariables, Env } from "./env";
import { adminAuth } from "./lib/auth";
import { ApiError, errorResponse } from "./lib/errors";
import { createImportJob, getImportJob, planImportJob, uploadImportItem } from "./services/importJobs";

type AppEnv = { Bindings: Env; Variables: AppVariables };

function ok<T>(c: Context<AppEnv>, data: T, status: 200 | 201 = 200) {
  const payload: ApiEnvelope<T> = { data, requestId: c.get("requestId") };
  return c.json(payload, status);
}

const requestMetadata: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  await next();
  c.header("x-request-id", requestId);
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "same-origin");
};

const productionOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.env.ENVIRONMENT === "production" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (!c.env.ADMIN_ORIGIN || c.req.header("origin") !== c.env.ADMIN_ORIGIN) {
      throw new ApiError(403, "invalid_origin", "管理请求来源无效");
    }
  }
  await next();
};

const uploadSchema = z.object({
  relativePath: z.string().min(1).max(2048),
  markdown: z.string().min(1),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable().optional(),
});

export const app = new Hono<AppEnv>();
app.onError((error, c) => errorResponse(c, error));

app.use("/api/v1/collections/:collectionId/import-jobs", requestMetadata, productionOrigin, adminAuth());
app.post("/api/v1/collections/:collectionId/import-jobs", async (c) => {
  const collectionId = z.string().uuid().parse(c.req.param("collectionId"));
  return ok(c, await createImportJob(c.env, c.get("principal"), collectionId), 201);
});

app.use("/api/v1/import-jobs/:jobId", requestMetadata, adminAuth());
app.get("/api/v1/import-jobs/:jobId", async (c) => {
  const jobId = z.string().uuid().parse(c.req.param("jobId"));
  return ok(c, await getImportJob(c.env, c.get("principal"), jobId));
});

app.use("/api/v1/import-jobs/:jobId/items/:itemId", requestMetadata, productionOrigin, adminAuth());
app.put("/api/v1/import-jobs/:jobId/items/:itemId", async (c) => {
  const jobId = z.string().uuid().parse(c.req.param("jobId"));
  const itemId = z.string().uuid().parse(c.req.param("itemId"));
  const input = uploadSchema.parse(await c.req.json());
  return ok(c, await uploadImportItem(c.env, c.get("principal"), jobId, itemId, input));
});

app.use("/api/v1/import-jobs/:jobId/plan", requestMetadata, productionOrigin, adminAuth());
app.post("/api/v1/import-jobs/:jobId/plan", async (c) => {
  const jobId = z.string().uuid().parse(c.req.param("jobId"));
  return ok(c, await planImportJob(c.env, c.get("principal"), jobId));
});

app.route("/", baseApp);
