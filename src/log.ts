import { sanitizePostgresUrl } from "./sanitize.ts";

export const log = {
  info(message: string, source: string) {
    console.log(
      `[%c${source}%c] ${message}`,
      "color: blue; font-weight: bold",
      "",
    );
  },
  debug(message: string, source: string) {
    console.log(
      `[%c${source}%c] ${message}`,
      "color: gray; font-weight: bold",
      "",
    );
  },
  warn(message: string, source: string) {
    console.log(
      `[%c${source}%c] ${message}`,
      "color: yellow; font-weight: bold",
      "",
    );
  },
  error(message: string, source: string) {
    console.log(
      `[%c${source}%c] ${message}`,
      "color: red; font-weight: bold",
      "",
    );
  },
  http(request: Request): void {
    // don't log the db url
    const cloned = request.clone();
    const url = new URL(cloned.url);
    const db = url.searchParams.get("db");
    if (db) {
      const sanitized = sanitizePostgresUrl(db);
      url.searchParams.set("db", sanitized);
    }
    console.log(
      `[%c${request.method}%c] %c${url.pathname}%c${url.search}`,
      "color: magenta; font-weight: bold;",
      "",
      "color: magenta; font-weight: bold;",
      "color: magenta;",
    );
  },
};
