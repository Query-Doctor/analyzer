export class PostgresError extends Error {
  readonly statusCode = 500;

  constructor(message: string) {
    super(message);
  }

  toJSON() {
    return {
      kind: "error" as const,
      type: "unexpected_error" as const,
      error: this.message,
    };
  }

  toResponse(): Response {
    return Response.json(this.toJSON(), { status: this.statusCode });
  }
}

export class ExtensionNotInstalledError extends Error {
  readonly statusCode = 400;

  constructor(public readonly extension: string) {
    super(`extension ${extension} is not installed`);
  }

  toJSON() {
    return {
      kind: "error" as const,
      type: "extension_not_installed" as const,
      extensionName: this.message,
    };
  }

  toResponse(): Response {
    return Response.json(this.toJSON(), { status: this.statusCode });
  }
}

export class MaxTableIterationsReached extends Error {
  readonly statusCode = 500;

  constructor(public readonly maxIterations: number) {
    super(`max table iterations reached: ${maxIterations}`);
  }

  toJSON() {
    return {
      kind: "error" as const,
      type: "max_table_iterations_reached" as const,
      error: "Max table iterations reached. This is a bug with the syncer",
    };
  }

  toResponse(): Response {
    return Response.json(this.toJSON(), { status: this.statusCode });
  }
}
