import { app } from "./api";
import type { Env, IndexQueueMessage } from "./env";
import { handleIndexQueue } from "./services/indexer";
import { recoverStaleJobs } from "./services/jobs";

export default {
  fetch: app.fetch,
  queue(batch: MessageBatch<IndexQueueMessage>, env: Env) {
    return handleIndexQueue(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(recoverStaleJobs(env));
  },
} satisfies ExportedHandler<Env, IndexQueueMessage>;
