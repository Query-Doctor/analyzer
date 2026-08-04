/**
 * How much of a failed command's output to carry in the thrown error.
 *
 * pg_restore reports one line per object it could not create, so a schema with
 * a missing extension produces hundreds. The cause is in the last of them, and
 * in the summary line that follows.
 */
const MAX_OUTPUT_CHARS = 2000;

/**
 * Describes a failed child process using the output it already produced.
 *
 * The output reaches us as events and was previously forwarded to a websocket,
 * which the live UI subscribes to and CI does not. A CI job therefore saw
 * `Restore failed with status 1` and nothing else, while pg_restore had already
 * printed the missing extension or collation by name. Diagnosing it meant
 * reproducing the restore by hand outside CI.
 */
export function describeCommandFailure(
  command: string,
  code: number | null,
  output: readonly string[],
): string {
  const status = code === null ? "no exit code" : `status ${code}`;
  const captured = tail(output.join(""));
  if (!captured) {
    return `${command} failed with ${status}, and produced no output.`;
  }
  return `${command} failed with ${status}:\n${captured}`;
}

/** The end of the output, where the error and the summary are. */
function tail(output: string): string {
  const trimmed = output.trimEnd();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return `[earlier output omitted]\n${trimmed.slice(-MAX_OUTPUT_CHARS)}`;
}
