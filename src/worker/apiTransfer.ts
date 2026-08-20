import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";

import type { ApiEnvelope } from "@shared/contracts";

import { app as baseApp } from "./apiProvenance";
import type { AppVariables, Env } from "./env";
import { adminAuth } from "./lib/auth";
import { ApiError, errorResponse } from "./lib/errors";
import { createExportJob, readExportManifest, readExportObject, verifyBackupReport } from "./services/exportJobs";
import { applyImportJob, cancelImportJob } from "./services/importApply";
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

const applySchema = z.object({
  planVersion: z.number().int().positive(),
  decisions: z.array(z.object({
    itemId: z.string().uuid(),
    decision: z.enum(["skip", "overwrite", "copy"]),
    copyPath: z.string().min(1).max(2048).nullable().optional(),
  })).max(500).default([]),
});

const exportSchema = z.object({
  kind: z.enum(["portable", "backup"]),
});

const verifyBackupSchema = z.object({
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/i),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/i),
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

app.use("/api/v1/import-jobs/:jobId/apply", requestMetadata, productionOrigin, adminAuth());
app.post("/api/v1/import-jobs/:jobId/apply", async (c) => {
  const jobId = z.string().uuid().parse(c.req.param("jobId"));
  const input = applySchema.parse(await c.req.json());
  return ok(c, await applyImportJob(c.env, c.get("principal"), jobId, input));
});

app.use("/api/v1/import-jobs/:jobId/cancel", requestMetadata, productionOrigin, adminAuth());
app.post("/api/v1/import-jobs/:jobId/cancel", async (c) => {
  const jobId = z.string().uuid().parse(c.req.param("jobId"));
  return ok(c, await cancelImportJob(c.env, c.get("principal"), jobId));
});

app.use("/api/v1/collections/:collectionId/export-jobs", requestMetadata, productionOrigin, adminAuth());
app.post("/api/v1/collections/:collectionId/export-jobs", async (c) => {
  const collectionId = z.string().uuid().parse(c.req.param("collectionId"));
  const input = exportSchema.parse(await c.req.json());
  return ok(c, await createExportJob(c.env, c.get("principal"), collectionId, input.kind), 201);
});

app.use("/api/v1/export-jobs/:jobId/manifest", requestMetadata, adminAuth());
app.get("/api/v1/export-jobs/:jobId/manifest", async (c) => {
  const jobId = z.string().uuid().parse(c.req.param("jobId"));
  return ok(c, await readExportManifest(c.env, c.get("principal"), jobId));
});

app.use("/api/v1/export-jobs/:jobId/objects/:objectId", requestMetadata, adminAuth());
app.get("/api/v1/export-jobs/:jobId/objects/:objectId", async (c) => {
  const jobId = z.string().uuid().parse(c.req.param("jobId"));
  const objectId = z.string().uuid().parse(c.req.param("objectId"));
  const result = await readExportObject(c.env, c.get("principal"), jobId, objectId);
  c.header("cache-control", "no-store");
  c.header("x-content-sha256", result.row.sha256);
  c.header("x-export-logical-path", encodeURIComponent(result.row.logicalPath));
  c.header(
    "content-type",
    result.row.objectKind.endsWith("markdown")
      ? "text/markdown; charset=utf-8"
      : "application/json; charset=utf-8",
  );
  return c.body(result.bytes);
});

app.use("/api/v1/export-jobs/:jobId/verify", requestMetadata, productionOrigin, adminAuth());
app.post("/api/v1/export-jobs/:jobId/verify", async (c) => {
  const jobId = z.string().uuid().parse(c.req.param("jobId"));
  const input = verifyBackupSchema.parse(await c.req.json());
  return ok(c, await verifyBackupReport(c.env, c.get("principal"), jobId, input));
});

app.route("/", baseApp);
