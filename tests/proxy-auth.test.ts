import { describe, expect, it } from "vitest";

import type { Env } from "@worker/env";
import { verifyProxyAdmin } from "@worker/lib/auth";

describe("management proxy authentication", () => {
  const env = {
    ADMIN_PROXY_SECRET: "server-only-secret",
    BOOTSTRAP_ADMIN_EMAILS: "admin@example.com",
    ADMIN_LOGIN_EMAIL: "admin@example.com",
  } as Env;

  it("accepts the server secret and normalizes the administrator identity", async () => {
    await expect(verifyProxyAdmin(env, "server-only-secret", " Admin@Example.com ")).resolves.toEqual({
      email: "admin@example.com",
      subject: "proxy:admin@example.com",
      bootstrapAdmin: true,
    });
  });

  it("rejects invalid server credentials", async () => {
    await expect(verifyProxyAdmin(env, "wrong-secret", "admin@example.com")).rejects.toThrow("管理代理身份凭证无效");
  });
});
