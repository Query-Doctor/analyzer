import { z } from "zod";
import { PgIdentifier } from "@query-doctor/core";

export const ToggleIndexDto = z.object({
  indexName: z.string().min(1).max(64).transform((value) =>
    PgIdentifier.fromString(value)
  ),
});

export type ToggleIndexDto = z.infer<typeof ToggleIndexDto>;

export const CreateIndexDto = z.object({
  connectionString: z.string().min(1),
  table: z.string().min(1),
  columns: z
    .array(
      z.object({
        name: z.string().min(1),
        order: z.enum(["asc", "desc"]),
      }),
    )
    .min(1),
});

export type CreateIndexDto = z.infer<typeof CreateIndexDto>;

