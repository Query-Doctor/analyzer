export function preprocessEncodedJson(jsonString: string): string | undefined {
  let isJSONOutput = false;
  let i = 0;
  for (; i < jsonString.length; i++) {
    const char = jsonString[i];
    // skipping escaped newlines
    if (char === "\\" && jsonString[i + 1] === "n") {
      i++;
      continue;
    } else if (/\s+/.test(char)) {
      // probably not incredibly performant
      continue;
    } else if (char === "{") {
      isJSONOutput = true;
      break;
    }
  }
  if (!isJSONOutput) {
    return;
  }
  return unescapeEncodedJson(jsonString.slice(i));
}

function unescapeEncodedJson(jsonString: string) {
  return (
    jsonString
      .replace(/\\n/g, "\n")
      // there are random control characters in the json lol
      // deno-lint-ignore no-control-regex
      .replace(/[\u0000-\u001F]+/g, (c) =>
        c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : ""
      )
  );
}
