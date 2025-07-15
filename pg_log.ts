export class ExplainedLog {
  private readonly json: object;
  private static readonly paramPattern =
    /\$(\d+)\s*=\s*(?:'([^']*)'|([^,\s]+))/g;
  constructor(
    stringifiedJson: string,
    // public readonly timestamp: Date,
    // public readonly query: string,
    // public readonly plan: string,
  ) {
    this.json = JSON.parse(stringifiedJson);
  }

  get query(): string {
    if (
      !("Query Text" in this.json) ||
      typeof this.json["Query Text"] !== "string"
    ) {
      console.error(this.json);
      throw new Error("Query Text not found");
    }
    return this.json["Query Text"];
  }

  get plan(): Plan {
    if (!("Plan" in this.json)) {
      console.error(this.json);
      throw new Error("Plan not found");
    }
    return new Plan(this.json["Plan"] as object);
  }

  get parameters(): string[] {
    if (!("Query Parameters" in this.json)) {
      return [];
    }
    if (typeof this.json["Query Parameters"] !== "string") {
      console.error(this.json);
      throw new Error("Query Parameters not found");
    }
    return this.extractParams(this.json["Query Parameters"]);
  }

  private extractParams(logLine: string) {
    const paramsArray = [];
    let match;

    while ((match = ExplainedLog.paramPattern.exec(logLine)) !== null) {
      const paramValue = match[2] !== undefined ? match[2] : match[3];
      // Push the value directly into the array.
      // The order is determined by the $1, $2, etc. in the log line.
      paramsArray[parseInt(match[1]) - 1] = paramValue;
    }

    return paramsArray.filter((value) => value !== undefined);
  }

  /**
   * Whether this query was run by our tool.
   * Want to skip this to prevent analyzing our own queries.
   */
  get isIntrospection(): boolean {
    return this.query.includes("@qd_introspection");
  }
}

class Plan {
  constructor(private readonly json: object) {}

  get nodeType(): string {
    if (
      !("Node Type" in this.json) ||
      typeof this.json["Node Type"] !== "string"
    ) {
      console.error(this.json);
      throw new Error("Node Type not found");
    }
    return this.json["Node Type"];
  }
}
