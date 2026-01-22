import { z } from "zod";
import { PgIdentifier } from "@query-doctor/core";

export const ToggleIndexDto = z.object({
  indexName: z.string().min(1).max(64).transform((value) =>
    PgIdentifier.fromString(value)
  ),
});

export type ToggleIndexDto = z.infer<typeof ToggleIndexDto>;
