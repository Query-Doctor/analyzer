import { test, expect } from "vitest";
import { preprocessEncodedJson } from "./json.ts";

test("returns parsed JSON object from clean input", () => {
  const input = '{"key": "value"}';
  const result = preprocessEncodedJson(input);
  expect(result).toBe('{"key": "value"}');
});

test("skips leading whitespace before opening brace", () => {
  const input = '   \t  {"key": "value"}';
  const result = preprocessEncodedJson(input);
  expect(result).toBe('{"key": "value"}');
});

test("skips leading escaped newlines before opening brace", () => {
  const input = '\\n\\n{"key": "value"}';
  const result = preprocessEncodedJson(input);
  expect(result).toBe('{"key": "value"}');
});

test("returns undefined for non-JSON input", () => {
  expect(preprocessEncodedJson("hello world")).toBeUndefined();
});

test("returns undefined for empty string", () => {
  expect(preprocessEncodedJson("")).toBeUndefined();
});

test("round-trips \\n: unescapes then re-escapes newlines", () => {
  // \\n (literal backslash-n) → real newline → \\n (control char handler re-escapes)
  const input = '{"key":\\n"value"}';
  const result = preprocessEncodedJson(input);
  expect(result).toBe('{"key":\\n"value"}');
});

test("strips control characters but preserves escaped \\n, \\r, \\t", () => {
  // A real newline (from unescaping) should be preserved as \\n in the output
  const input = '{"key": "val\\nue"}';
  const result = preprocessEncodedJson(input);
  // \\n becomes real \n, then the control char replacement turns \n back to \\n
  expect(result).toBe('{"key": "val\\nue"}');
});

test("strips NUL and other low control characters", () => {
  const input = '{"key": "val\x01\x02ue"}';
  const result = preprocessEncodedJson(input);
  expect(result).toBe('{"key": "value"}');
});

test("handles mixed leading whitespace and escaped newlines", () => {
  const input = '  \\n  \\n  {"data": 1}';
  const result = preprocessEncodedJson(input);
  expect(result).toBe('{"data": 1}');
});

test("preserves \\r as escaped sequence after unescaping", () => {
  const input = '{"key": "val\rue"}';
  const result = preprocessEncodedJson(input);
  expect(result).toBe('{"key": "val\\rue"}');
});

test("preserves \\t as escaped sequence after unescaping", () => {
  const input = '{"key": "val\tue"}';
  const result = preprocessEncodedJson(input);
  expect(result).toBe('{"key": "val\\tue"}');
});

test("skips non-whitespace characters before opening brace", () => {
  expect(preprocessEncodedJson('abc{"key": 1}')).toBe('{"key": 1}');
});

test("returns undefined for whitespace-only input", () => {
  expect(preprocessEncodedJson("   \\n\\n   ")).toBeUndefined();
});
