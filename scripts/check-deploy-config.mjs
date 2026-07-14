import { readFileSync } from "node:fs";
import path from "node:path";

import JSON5 from "json5";

const configPath = path.resolve(process.cwd(), process.argv[2] ?? "wrangler.jsonc");
const errors = [];
const warnings = [];

let config;
try {
  config = JSON5.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[deploy:check] Cannot parse ${configPath}: ${message}`);
  process.exit(1);
}

function requireValue(condition, message) {
  if (!condition) errors.push(message);
}

const vars = config.vars ?? {};
const database = config.d1_databases?.find((binding) => binding.binding === "DB");
const bucket = config.r2_buckets?.find((binding) => binding.binding === "NOTES");
const vector = config.vectorize?.find((binding) => binding.binding === "VECTOR_INDEX");
const producer = config.queues?.producers?.find((binding) => binding.binding === "INDEX_QUEUE");
const consumer = config.queues?.consumers?.find((binding) => binding.queue === producer?.queue);
const apiRoute = config.routes?.find((route) => (
  typeof route === "object"
  && route.pattern === "rag-api.coylin.com"
  && route.custom_domain === true
));

requireValue(config.name === "knowledge-core", "Worker name must remain knowledge-core.");
requireValue(config.main === "src/worker/index.ts", "Worker entry must be src/worker/index.ts.");
requireValue(vars.ENVIRONMENT === "production", "ENVIRONMENT must be production.");
requireValue(vars.DEV_AUTH_BYPASS === "false", "DEV_AUTH_BYPASS must be false.");
requireValue(typeof vars.BOOTSTRAP_ADMIN_EMAILS === "string" && vars.BOOTSTRAP_ADMIN_EMAILS.trim(), "BOOTSTRAP_ADMIN_EMAILS is empty.");
requireValue(vars.ADMIN_LOGIN_EMAIL === "admin@coylin.com", "ADMIN_LOGIN_EMAIL must be admin@coylin.com.");
requireValue(vars.ADMIN_ORIGIN === "https://rag.coylin.com", "ADMIN_ORIGIN must be https://rag.coylin.com.");
requireValue(config.ai?.binding === "AI", "Workers AI must use the AI binding.");
requireValue(vars.EMBEDDING_MODEL === "@cf/baai/bge-m3", "Default embedding model must be @cf/baai/bge-m3.");

requireValue(database?.database_name === "knowledge-core-db", "DB must bind knowledge-core-db.");
requireValue(
  typeof database?.database_id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(database.database_id)
    && database.database_id !== "00000000-0000-0000-0000-000000000001",
  "D1 database_id is missing or still uses the placeholder.",
);
requireValue(bucket?.bucket_name === "knowledge-core-notes", "NOTES must bind knowledge-core-notes.");
requireValue(vector?.index_name === "knowledge-core-v1", "VECTOR_INDEX must bind knowledge-core-v1.");
requireValue(producer?.queue === "knowledge-core-index", "INDEX_QUEUE must bind knowledge-core-index.");
requireValue(consumer?.max_retries === 5, "Queue max_retries must remain 5.");
requireValue(consumer?.dead_letter_queue === "knowledge-core-index-dlq", "Queue must use knowledge-core-index-dlq.");
requireValue(!config.assets, "Worker must not serve frontend assets in the split deployment.");
requireValue(Boolean(apiRoute), "Worker custom domain must be rag-api.coylin.com.");

if (!String(vars.RERANK_BASE_URL ?? "").trim() || !String(vars.RERANK_MODEL ?? "").trim()) {
  warnings.push("Reranker is not configured; retrieval will use the RRF fallback.");
}
warnings.push("ADMIN_PROXY_SECRET, ADMIN_LOGIN_PASSWORD_HASH, ADMIN_SESSION_SECRET, optional rerank Secrets and the Vectorize metadata index require separate account-side verification.");

for (const warning of warnings) console.warn(`[deploy:check] Warning: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`[deploy:check] Error: ${error}`);
  console.error(`[deploy:check] Failed with ${errors.length} blocking issue(s).`);
  process.exit(1);
}

console.log(`[deploy:check] ${path.basename(configPath)} is ready for production deployment.`);
