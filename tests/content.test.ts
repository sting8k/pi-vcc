import { describe, it, expect } from "bun:test";
import { textParts, textOf, clip, firstLine } from "../src/core/content";

describe("textParts", () => {
  it("returns [] for undefined content", () => {
    expect(textParts(undefined as any)).toEqual([]);
  });

  it("returns [] for null content", () => {
    expect(textParts(null as any)).toEqual([]);
  });

  it("wraps string content", () => {
    expect(textParts("hello")).toEqual(["hello"]);
  });

  it("extracts text parts from array content", () => {
    const content = [
      { type: "text" as const, text: "first" },
      { type: "toolCall" as const, name: "x", id: "1", arguments: {} },
      { type: "text" as const, text: "second" },
    ];
    expect(textParts(content)).toEqual(["first", "second"]);
  });
});

describe("textOf", () => {
  it("returns empty string for undefined content", () => {
    expect(textOf(undefined as any)).toBe("");
  });
});
