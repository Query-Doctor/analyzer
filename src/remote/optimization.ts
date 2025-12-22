import z from "zod";

export const LiveQueryOptimization = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("waiting"),
  }),
  z.object({ state: z.literal("optimizing") }),
  z.object({ state: z.literal("not_supported"), reason: z.string() }),
  z.object({
    state: z.literal("improvements_available"),
    cost: z.number(),
    optimizedCost: z.number(),
    costReductionPercentage: z.number(),
    indexRecommendations: z.array(z.string()),
    indexesUsed: z.array(z.string()),
  }),
  z.object({
    state: z.literal("no_improvement_found"),
    cost: z.number(),
    indexesUsed: z.array(z.string()),
  }),
  z.object({ state: z.literal("timeout") }),
  z.object({ state: z.literal("error"), error: z.instanceof(Error) }),
]);

export type LiveQueryOptimization = z.infer<typeof LiveQueryOptimization>;
