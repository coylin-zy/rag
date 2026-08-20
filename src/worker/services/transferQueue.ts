import type { Env, TransferQueueMessage } from "@worker/env";

import { processImportApplyMessage } from "./importApply";

export async function handleTransferQueue(batch: MessageBatch<TransferQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processImportApplyMessage(env, message.body);
      message.ack();
    } catch {
      message.retry();
    }
  }
}
