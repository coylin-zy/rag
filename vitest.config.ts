import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // process.cwd() lets Windows users run the suite through an ASCII path alias.
  // workerd currently cannot start from a workspace path containing non-ASCII characters.
  const root = process.cwd();
  const migrations = await readD1Migrations(path.resolve(root, "migrations"));

  return {
    resolve: {
      alias: {
        "@shared": path.resolve(root, "src/shared"),
        "@worker": path.resolve(root, "src/worker"),
      },
    },
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          compatibilityFlags: ["service_binding_extra_handlers"],
          bindings: { TEST_MIGRATIONS: migrations },
          queueConsumers: {
            "knowledge-core-test-index": { maxBatchTimeout: 0.05 },
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./tests/setup.ts"],
      include: ["tests/**/*.test.ts"],
      testTimeout: 15_000,
      hookTimeout: 15_000,
    },
  };
});
