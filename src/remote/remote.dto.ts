import { z } from "zod";
import { Connectable } from "../sync/connectable.ts";
import { FullSchema } from "../sync/schema_differ.ts";
import { OptimizedQuery } from "../sql/recent-query.ts";

export const RemoteSyncRequest = z.codec(
  z.string(),
  z.object({
    db: z.custom<Connectable>(),
  }),
  {
    encode: (value) => JSON.stringify({ db: value.db.toString() }),
    decode: (value) => {
      const parsed = JSON.parse(value);
      return { db: Connectable.fromString(parsed.db) };
    },
  },
);

export const RemoteSyncFullSchemaResponse = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ok"), value: FullSchema }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

export type RemoteSyncFullSchemaResponse = z.infer<
  typeof RemoteSyncFullSchemaResponse
>;

export const RemoteSyncQueriesResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ok"),
    value: z.array(z.custom<OptimizedQuery>()),
  }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

export const RemoteSyncResponse = z.object({
  // queries: RemoteSyncQueriesResponse,
  schema: RemoteSyncFullSchemaResponse,
});

export type RemoteSyncResponse = z.infer<typeof RemoteSyncResponse>;
