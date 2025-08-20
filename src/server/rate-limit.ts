import { RateLimiter, RateLimitResult } from "@rabbit-company/rate-limiter";

export const sync = new RateLimiter({
  window: 15 * 60 * 1000, // 15 minutes (default: 1 minute)
  max: 100, // Limit each identifier to 100 requests per window (default: 60)
  cleanupInterval: 60 * 1000, // Cleanup every minute (default: 30 seconds)
  enableCleanup: true, // Enable automatic cleanup (default: true)
});

export function appendHeaders(
  res: Response,
  result: RateLimitResult,
): Response {
  res.headers.set("X-RateLimit-Limit", result.limit.toString());
  res.headers.set("X-RateLimit-Window", "15m");
  res.headers.set("X-RateLimit-Remaining", result.remaining.toString());
  const ratelimitReset = new Date(result.reset).toUTCString();
  if (result.limited) {
    res.headers.set("Retry-After", ratelimitReset);
  } else {
    res.headers.set("X-RateLimit-Reset", ratelimitReset);
  }
  return res;
}
