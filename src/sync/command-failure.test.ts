import { describe, expect, test } from "vitest";
import { describeCommandFailure } from "./command-failure.ts";

describe("describeCommandFailure", () => {
  test("includes the output the command already produced", () => {
    // The failure that cost two CI runs on a real repository. pg_restore said
    // exactly why it failed; the analyzer reported only `status 1`, and the
    // stderr went to a websocket that CI does not have.
    const message = describeCommandFailure("pg_restore", 1, [
      'pg_restore: error: could not execute query: ERROR:  extension "vector" is not available\n',
      "pg_restore: warning: errors ignored on restore: 16\n",
    ]);

    expect(message).toContain("pg_restore");
    expect(message).toContain("status 1");
    expect(message).toContain('extension "vector" is not available');
  });

  test("still names the command and code when nothing was captured", () => {
    const message = describeCommandFailure("pg_dump", 2, []);

    expect(message).toContain("pg_dump");
    expect(message).toContain("status 2");
  });

  test("keeps the end of a long output, where the error is", () => {
    // pg_restore reports per-object errors and then its summary. Truncating
    // from the end would drop the line that says how the run ended.
    const noise = Array.from({ length: 500 }, (_, i) => `line ${i}\n`);
    const message = describeCommandFailure("pg_restore", 1, [
      ...noise,
      "pg_restore: warning: errors ignored on restore: 16\n",
    ]);

    expect(message).toContain("errors ignored on restore: 16");
    expect(message).not.toContain("line 0\n");
    expect(message.length).toBeLessThan(4000);
  });

  test("reports a signal when the command did not exit with a code", () => {
    const message = describeCommandFailure("pg_restore", null, ["boom\n"]);

    expect(message).toContain("pg_restore");
    expect(message).toContain("boom");
  });
});
