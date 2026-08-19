import { app } from "./api";
import type { Env, IndexQueueMessage } from "./env";
import { handleIndexQueue } from "./services/indexer";
import { recoverStaleJobs } from "./services/jobs";
import { cleanupTokenRiskData } from "./services/tokenRisk";

export default {
  fetch: app.fetch,
  queue(batch: MessageBatch<IndexQueueMessage>, env: Env) {
    return handleIndexQueue(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([recoverStaleJobs(env), cleanupTokenRiskData(env)]));
  },
} satisfies ExportedHandler<Env, IndexQueueMessage>;
