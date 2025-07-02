export class ExplainedLog {
  private readonly json: object;
  private static readonly paramPattern =
    /\$(\d+)\s*=\s*(?:'([^']*)'|([^,\s]+))/g;
  constructor(
    stringifiedJson: string
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

    // Filter out any empty slots if parameters were not consecutive (e.g., $1, $3 present, but $2 missing)
    // This ensures a dense array without 'empty' items.
    return paramsArray.filter((value) => value !== undefined);
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
