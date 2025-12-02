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

export const RemoteSyncQueriesResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ok"),
    value: z.array(z.instanceof(RecentQuery)),
  }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

export const RemoteSyncResponse = z.object({
  queries: RemoteSyncQueriesResponse,
  schema: RemoteSyncFullSchemaResponse,
});

export type RemoteSyncResponse = z.infer<typeof RemoteSyncResponse>;
