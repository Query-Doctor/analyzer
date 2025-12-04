import { z } from "zod";
import { ConnectableParser } from "../sync/connectable.ts";

export const LiveQueryRequest = z.object({
  db: ConnectableParser,
});

export type LiveQueryRequest = z.infer<typeof LiveQueryRequest>;

export const SyncRequest = z.object({
  db: ConnectableParser,
  seed: z.coerce.number().min(0).max(1).default(0),
  schema: z.coerce.string().default("public").meta({
    deprecated: true,
    description: "Analyzer always syncs all schemas available",
  }),
  requiredRows: z.coerce.number().nonnegative().default(2),
  maxRows: z.coerce.number().nonnegative().default(8),
});

export type SyncRequest = z.infer<typeof SyncRequest>;
