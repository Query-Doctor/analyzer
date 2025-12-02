import { z } from "zod";
import { Connectable } from "../sync/connectable.ts";
import { RecentQuery } from "../sql/recent-query.ts";
import { FullSchema } from "../sync/schema_differ.ts";

export const RemoteSyncRequest = z.object({
  db: z.string().transform(Connectable.transform),
});

export const RemoteSyncFullSchemaResponse = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ok"), value: FullSchema }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

export const RemoteSyncResponse = z.object({
  queries: z.array(z.instanceof(RecentQuery)),
  schema: RemoteSyncFullSchemaResponse,
});

export type RemoteSyncResponse = z.infer<typeof RemoteSyncResponse>;
