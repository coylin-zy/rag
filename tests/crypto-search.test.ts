import { describe, expect, it } from "vitest";

import { deterministicId, generateToken, sha256 } from "@worker/lib/crypto";
import { reciprocalRankFusion } from "@worker/services/search";

describe("hashing and retrieval ranking", () => {
  it("uses stable SHA-256 hashes and deterministic identifiers", async () => {
    expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await deterministicId("abc")).toBe("ba7816bf8f01cfea414140de5dae2223");
  });

  it("generates opaque MCP credentials", () => {
    const first = generateToken();
    const second = generateToken();
    expect(first).toMatch(/^kcore_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("rewards candidates present in both RRF rankings", () => {
    const scores = reciprocalRankFusion([["lexical", "both"], ["both", "semantic"]]);
    expect(scores.get("both")).toBeGreaterThan(scores.get("lexical") ?? 0);
    expect(scores.get("both")).toBeGreaterThan(scores.get("semantic") ?? 0);
  });
});
