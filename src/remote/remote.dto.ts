import { z } from "zod";
import { Connectable } from "../sync/connectable.ts";
import { RecentQuery } from "../sql/recent-query.ts";

export const RemoteSyncRequest = z.object({
  db: z.string().transform(Connectable.transform),
});

export const RemoteSyncResponse = z.object({
  queries: z.array(z.instanceof(RecentQuery)),
});

export type RemoteSyncResponse = z.infer<typeof RemoteSyncResponse>;
