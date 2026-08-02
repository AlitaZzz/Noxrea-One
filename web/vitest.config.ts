import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["./src/__tests__/setup.ts"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
