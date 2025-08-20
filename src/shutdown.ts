export const shutdownController = new AbortController();

export function shutdown() {
  shutdownController.abort();
  Deno.exit(0);
}
