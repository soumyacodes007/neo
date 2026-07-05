import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts"],
      // Vol 01 §2.8: packages other than core 85%; the ScVal bridge is held to
      // 100% branch coverage by its own dedicated test (checked in scval.test.ts).
      thresholds: { lines: 85, branches: 85 },
    },
  },
});
