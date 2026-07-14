import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { app } from "@worker/api";
import type { Env } from "@worker/env";
import { sha256 } from "@worker/lib/crypto";

const ADMIN_EMAIL = "admin@coylin.com";
const ADMIN_PASSWORD = "test-password";
const PROXY_SECRET = "test-proxy-secret";

let productionEnv: Env;

beforeAll(async () => {
  productionEnv = {
    ...env,
    ENVIRONMENT: "production",
    DEV_AUTH_BYPASS: "false",
    BOOTSTRAP_ADMIN_EMAILS: ADMIN_EMAIL,
    ADMIN_LOGIN_EMAIL: ADMIN_EMAIL,
    ADMIN_LOGIN_PASSWORD_HASH: await sha256(ADMIN_PASSWORD),
    ADMIN_SESSION_SECRET: "test-session-secret-that-is-long-enough",
    ADMIN_PROXY_SECRET: PROXY_SECRET,
    ADMIN_ORIGIN: "https://rag.coylin.com",
    CF_ACCESS_TEAM_DOMAIN: "",
    CF_ACCESS_AUD: "",
  };
});

function request(path: string, init: RequestInit = {}) {
  return app.request(`https://rag-api.coylin.com${path}`, init, productionEnv);
}

function loginInit(password = ADMIN_PASSWORD, origin = "https://rag.coylin.com"): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": origin,
      "x-knowledge-proxy-secret": PROXY_SECRET,
    },
    body: JSON.stringify({ email: ADMIN_EMAIL, password }),
  };
}

describe("administrator login session", () => {
  it("rejects an incorrect password without setting a cookie", async () => {
    const response = await request("/api/v1/auth/login", loginInit("wrong-password"));
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("invalid_login");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("issues a secure HttpOnly cookie and accepts it for the session endpoint", async () => {
    const login = await request("/api/v1/auth/login", loginInit());
    const setCookie = login.headers.get("set-cookie") ?? "";

    expect(login.status).toBe(200);
    expect(setCookie).toContain("knowledge_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=43200");

    const cookie = setCookie.split(";", 1)[0];
    const session = await request("/api/v1/session", {
      headers: {
        cookie,
        "x-knowledge-admin-email": ADMIN_EMAIL,
        "x-knowledge-proxy-secret": PROXY_SECRET,
      },
    });
    const body = await session.json() as { data: { principal: { email: string } } };

    expect(session.status).toBe(200);
    expect(body.data.principal.email).toBe(ADMIN_EMAIL);
  });

  it("rejects a management session without a signed cookie", async () => {
    const response = await request("/api/v1/session", {
      headers: {
        "x-knowledge-admin-email": ADMIN_EMAIL,
        "x-knowledge-proxy-secret": PROXY_SECRET,
      },
    });
    expect(response.status).toBe(401);
  });

  it("clears the browser cookie on logout", async () => {
    const response = await request("/api/v1/auth/logout", {
      method: "POST",
      headers: {
        origin: "https://rag.coylin.com",
        "x-knowledge-proxy-secret": PROXY_SECRET,
      },
    });
    const setCookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(200);
    expect(setCookie).toContain("knowledge_session=");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("rejects cross-origin management writes", async () => {
    const response = await request("/api/v1/auth/login", loginInit(ADMIN_PASSWORD, "https://evil.example"));
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("invalid_origin");
  });
});
