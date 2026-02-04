import { Span, SpanStatusCode, trace } from "@opentelemetry/api";

export const tracer = trace.getTracer("sync", "0.0.1");

export function withSpan<Args extends unknown[], T>(
  name: string,
  cb: (span: Span, ...args: Args) => Promise<T> | T,
): (...args: Args) => Promise<T> {
  return (...args: Args) => {
    return tracer.startActiveSpan(name, async (span) => {
      try {
        return await cb(span, ...args);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}

export type Timed<T> = { data: T; ms: number };

export async function withTiming<T>(
  f: () => Promise<T>,
): Promise<Timed<T>> {
  const prev = Date.now();
  const data = await f();
  const ms = Date.now() - prev;
  return { data, ms };
}
