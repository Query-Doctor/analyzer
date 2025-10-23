export class PostgresError extends Error {
  constructor(message: string) {
    super(message);
  }

  toResponse(): Response {
    return Response.json(
      {
        kind: "error",
        type: "unexpected_error",
        error: this.message,
      },
      { status: 500 },
    );
  }
}

export class ExtensionNotInstalledError extends Error {
  constructor(public readonly extension: string) {
    super(`extension ${extension} is not installed`);
  }

  toResponse(): Response {
    return Response.json(
      {
        kind: "error",
        type: "extension_not_installed",
        extensionName: this.message,
      },
      { status: 400 },
    );
  }
}

export class MaxTableIterationsReached extends Error {
  constructor(public readonly maxIterations: number) {
    super(`max table iterations reached: ${maxIterations}`);
  }

  toResponse(): Response {
    return Response.json(
      {
        kind: "error",
        type: "max_table_iterations_reached",
        error: "Max table iterations reached. This is a bug with the syncer",
      },
      { status: 500 },
    );
  }
}
