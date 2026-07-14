import { createDb } from "../db/client";
import { auditLogs } from "../db/schema";
import type { Env } from "@worker/env";

import { nowIso } from "./utils";

export async function writeAudit(
  env: Env,
  entry: {
    actorType: "user" | "token" | "system";
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    collectionIds?: string[];
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const db = createDb(env.DB);
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorType: entry.actorType,
    actorId: entry.actorId,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    collectionIdsJson: JSON.stringify([...new Set(entry.collectionIds ?? [])]),
    metadataJson: JSON.stringify(entry.metadata ?? {}),
    createdAt: nowIso(),
  });
}
