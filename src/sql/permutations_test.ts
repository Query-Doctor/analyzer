import { permuteWithFeedback, PROCEED, SKIP } from "../optimizer/genalgo.ts";
import { assertEquals } from "@std/assert";

Deno.test("permutations", () => {
  const fn = permuteWithFeedback([1, 2, 3]);
  const next1 = fn.next(PROCEED);
  const next2 = fn.next(PROCEED);
  const next3 = fn.next(PROCEED);
  const next4 = fn.next(PROCEED);
  const next5 = fn.next(PROCEED);
  const next6 = fn.next(PROCEED);
  const next7 = fn.next(PROCEED);
  const next8 = fn.next(PROCEED);
  const next9 = fn.next(PROCEED);
  const next10 = fn.next(PROCEED);
  const next11 = fn.next(PROCEED);
  const next12 = fn.next(PROCEED);
  const next13 = fn.next(PROCEED);
  const next14 = fn.next(PROCEED);
  const next15 = fn.next(PROCEED);
  const next16 = fn.next(PROCEED);

  assertEquals(next1.value, [1]);
  assertEquals(next2.value, [1, 2]);
  assertEquals(next3.value, [1, 2, 3]);
  assertEquals(next4.value, [1, 3]);
  assertEquals(next5.value, [1, 3, 2]);
  assertEquals(next6.value, [2]);
  assertEquals(next7.value, [2, 1]);
  assertEquals(next8.value, [2, 1, 3]);
  assertEquals(next9.value, [2, 3]);
  assertEquals(next10.value, [2, 3, 1]);
  assertEquals(next11.value, [3]);
  assertEquals(next12.value, [3, 1]);
  assertEquals(next13.value, [3, 1, 2]);
  assertEquals(next14.value, [3, 2]);
  assertEquals(next15.value, [3, 2, 1]);
  assertEquals(next16.done, true);
});

Deno.test("permutations with skip", () => {
  const fn = permuteWithFeedback([1, 2, 3]);
  const next1 = fn.next(PROCEED);
  const next2 = fn.next(SKIP);
  const next3 = fn.next(PROCEED);
  const next4 = fn.next(SKIP);
  const next5 = fn.next(SKIP);
  const next6 = fn.next(SKIP);

  assertEquals(next1.value, [1]);
  assertEquals(next2.value, [2]);
  assertEquals(next3.value, [2, 1]);
  assertEquals(next4.value, [2, 3]);
  assertEquals(next5.value, [3]);
  assertEquals(next6.done, true);
});
