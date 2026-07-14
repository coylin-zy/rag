import { describe, expect, it, vi } from "vitest";

import type { Env } from "@worker/env";
import { embedTexts } from "@worker/lib/models";

describe("embedding providers", () => {
  it("uses the native Workers AI BGE-M3 binding in production", async () => {
    const embedding = Array.from({ length: 1024 }, (_, index) => index / 1024);
    const run = vi.fn().mockResolvedValue({ shape: [1, 1024], data: [embedding] });
    const env = {
      AI: { run },
      ENVIRONMENT: "production",
      EMBEDDING_BASE_URL: "",
      EMBEDDING_API_KEY: "",
      EMBEDDING_MODEL: "@cf/baai/bge-m3",
    } as unknown as Env;

    await expect(embedTexts(env, ["知识库检索"])).resolves.toEqual([embedding]);
    expect(run).toHaveBeenCalledWith("@cf/baai/bge-m3", {
      text: ["知识库检索"],
      truncate_inputs: true,
    });
  });
});
