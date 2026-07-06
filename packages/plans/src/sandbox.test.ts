import { describe, expect, it } from "vitest";
import { assertOnlyFencedRegionsChanged, parseCargoDiagnostics, UnavailableSandbox } from "./sandbox.js";

const frozen = [
  "fn enforce() {",
  "    // >>> GENERATED: c:0",
  "    let a = 1;",
  "    // <<< GENERATED",
  "}",
].join("\n");

describe("assertOnlyFencedRegionsChanged (repair-loop diff-guard)", () => {
  it("allows edits inside the GENERATED fence", () => {
    const edited = frozen.replace("let a = 1;", "let a = 2;\n    let b = a < 3;");
    expect(() => assertOnlyFencedRegionsChanged(frozen, edited)).not.toThrow();
  });

  it("rejects edits to frozen template lines", () => {
    const tampered = frozen.replace("fn enforce() {", "fn enforce() { hack();");
    expect(() => assertOnlyFencedRegionsChanged(frozen, tampered)).toThrow(/E_BUILD_TEMPLATE|diff-guard/);
  });

  it("rejects adding a frozen line outside the fence", () => {
    const tampered = frozen.replace("}", "    drain();\n}");
    expect(() => assertOnlyFencedRegionsChanged(frozen, tampered)).toThrow();
  });
});

describe("parseCargoDiagnostics", () => {
  it("extracts errors from cargo --message-format=json output", () => {
    const line = JSON.stringify({
      reason: "compiler-message",
      message: { level: "error", message: "mismatched types", spans: [{ file_name: "src/lib.rs", line_start: 42 }] },
    });
    const noise = JSON.stringify({ reason: "compiler-artifact" });
    const diags = parseCargoDiagnostics([noise, line, ""].join("\n"));
    expect(diags).toEqual([{ level: "error", message: "mismatched types", file: "src/lib.rs", line: 42 }]);
  });
});

describe("UnavailableSandbox", () => {
  it("fails closed", () => {
    expect(() => new UnavailableSandbox().compilePolicy("/x")).toThrow(/no pinned .* sandbox/);
  });
});
