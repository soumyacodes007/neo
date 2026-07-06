import { describe, expect, it } from "vitest";
import { withToolBoundary } from "./tool-boundary.js";

describe("withToolBoundary", () => {
  it("wraps successful output in a JSON text MCP result", async () => {
    const result = await withToolBoundary("x", () => ({ value: 1 }))({});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
  });

  it("converts thrown errors into MCP error results", async () => {
    const result = await withToolBoundary("x", () => {
      throw new Error("E_TEST");
    })({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
  });
});
