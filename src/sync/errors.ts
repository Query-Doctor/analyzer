export class PostgresError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class ExtensionNotInstalledError extends Error {
  constructor(public readonly extension: string) {
    super(`extension ${extension} is not installed`);
  }
}

export class MaxTableIterationsReached extends Error {
  constructor(public readonly maxIterations: number) {
    super(`max table iterations reached: ${maxIterations}`);
  }
}
