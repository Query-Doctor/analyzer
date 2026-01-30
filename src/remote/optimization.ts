import type { PostgresExplainStage } from "@query-doctor/core";
import z from "zod";

const IndexRecommendation = z.object({
  schema: z.string(),
  table: z.string(),
  columns: z.array(z.object({
    schema: z.string(),
    table: z.string(),
    column: z.string(),
    sort: z.any().optional(),
    where: z.any().optional(),
  })),
  where: z.string().optional(),
  definition: z.string(),
});

export const LiveQueryOptimization = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("waiting"),
  }),
  z.object({
    state: z.literal("optimizing"),
    retries: z.number().nonnegative(),
  }),
  z.object({ state: z.literal("not_supported"), reason: z.string() }),
  z.object({
    state: z.literal("improvements_available"),
    cost: z.number(),
    optimizedCost: z.number(),
    costReductionPercentage: z.number(),
    indexRecommendations: z.array(IndexRecommendation),
    indexesUsed: z.array(z.string()),
    explainPlan: z.custom<PostgresExplainStage>(),
    optimizedExplainPlan: z.custom<PostgresExplainStage>(),
  }),
  z.object({
    state: z.literal("no_improvement_found"),
    cost: z.number(),
    indexesUsed: z.array(z.string()),
    explainPlan: z.custom<PostgresExplainStage>(),
  }),
  z.object({
    state: z.literal("timeout"),
    waitedMs: z.number(),
    retries: z.number().nonnegative(),
  }),
  z.object({
    state: z.literal("error"),
    error: z.string(),
    explainPlan: z.custom<PostgresExplainStage>().optional(),
  }),
]);

export type LiveQueryOptimization = z.infer<typeof LiveQueryOptimization>;
