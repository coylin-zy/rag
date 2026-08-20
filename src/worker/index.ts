import { app } from "./apiTransfer";
import type { Env, IndexQueueMessage, TransferQueueMessage } from "./env";
import { handleIndexQueue } from "./services/indexer";
import { recoverStaleJobs } from "./services/jobs";
import { cleanupTokenRiskData } from "./services/tokenRisk";
import { handleTransferQueue } from "./services/transferQueue";
import { recoverStaleTransfers } from "./services/transferRecovery";

type WorkerQueueMessage = IndexQueueMessage | TransferQueueMessage;

export default {
  fetch: app.fetch,
  queue(batch: MessageBatch<WorkerQueueMessage>, env: Env) {
    const first = batch.messages[0]?.body;
    if (first?.type === "import_apply") {
      return handleTransferQueue(batch as MessageBatch<TransferQueueMessage>, env);
    }
    return handleIndexQueue(batch as MessageBatch<IndexQueueMessage>, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([
      recoverStaleJobs(env),
      cleanupTokenRiskData(env),
      recoverStaleTransfers(env),
    ]));
  },
} satisfies ExportedHandler<Env, WorkerQueueMessage>;
