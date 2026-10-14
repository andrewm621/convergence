import { defineConfig } from "vitest/config";

// The runner tests start one Node process per vector, several hundred in all.
export default defineConfig({ test: { testTimeout: 120_000 } });
