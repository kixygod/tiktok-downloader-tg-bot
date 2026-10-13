import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerDashboardAuth } from "../dashboardAuth";

describe("dashboard HTTP Basic authentication", () => {
  it("requires an explicit username and password", async () => {
    const app = Fastify();
    await expect(registerDashboardAuth(app, "")).rejects.toThrow(
      "DASHBOARD_BASIC_AUTH must be configured",
    );
    await expect(registerDashboardAuth(app, ":password")).rejects.toThrow(
      "DASHBOARD_BASIC_AUTH must include a username and password",
    );
    await app.close();
  });

  it("challenges anonymous visitors and accepts configured credentials", async () => {
    const app = Fastify();
    await app.register(async (secured) => {
      await registerDashboardAuth(secured, "friend:private-pass");
      secured.get("/dashboard", async () => ({ ok: true }));
    });
    await app.ready();

    try {
      const anonymous = await app.inject({ method: "GET", url: "/dashboard" });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.headers["www-authenticate"]).toBe(
        'Basic realm="Media Bot Admin"',
      );

      const rejected = await app.inject({
        method: "GET",
        url: "/dashboard",
        headers: { authorization: `Basic ${Buffer.from("friend:wrong").toString("base64")}` },
      });
      expect(rejected.statusCode).toBe(401);
      expect(rejected.headers["www-authenticate"]).toBe(
        'Basic realm="Media Bot Admin"',
      );

      const accepted = await app.inject({
        method: "GET",
        url: "/dashboard",
        headers: { authorization: `Basic ${Buffer.from("friend:private-pass").toString("base64")}` },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
