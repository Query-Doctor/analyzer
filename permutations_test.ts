import { assertEquals } from "@std/assert";
import { permuteWithFeedback, PROCEED } from "./optimizer/genalgo.ts";

Deno.test("permutations", () => {
  const fn = permuteWithFeedback([1, 2, 3]);
  const result = [];
  const next1 = fn.next(PROCEED);
  const next2 = fn.next(PROCEED);
  const next3 = fn.next(PROCEED);
  const next4 = fn.next(PROCEED);
  const next5 = fn.next(PROCEED);
  const next6 = fn.next(PROCEED);

  console.log(next1);
  console.log(next2);
  console.log(next3);
  console.log(next4);
  console.log(next5);
  console.log(next6);
});
