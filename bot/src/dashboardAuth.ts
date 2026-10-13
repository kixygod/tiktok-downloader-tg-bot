import fastifyBasicAuth from "@fastify/basic-auth";
import type { FastifyInstance } from "fastify";
import { parseDashboardBasicAuth, timingSafeEqualUtf8 } from "./utils";

const DASHBOARD_AUTH_REALM = "Media Bot Admin";

export async function registerDashboardAuth(
  secured: FastifyInstance,
  rawCredentials?: string,
): Promise<void> {
  const configuredCredentials = rawCredentials ?? process.env.DASHBOARD_BASIC_AUTH;
  if (!configuredCredentials) {
    throw new Error("DASHBOARD_BASIC_AUTH must be configured");
  }
  const expected = parseDashboardBasicAuth(configuredCredentials);
  if (!expected.username || !expected.password) {
    throw new Error("DASHBOARD_BASIC_AUTH must include a username and password");
  }

  await secured.register(fastifyBasicAuth, {
    validate: async (username, password) => {
      const usernameMatches = timingSafeEqualUtf8(username, expected.username);
      const passwordMatches = timingSafeEqualUtf8(password, expected.password);
      if (!usernameMatches || !passwordMatches) {
        throw new Error("Dashboard authentication failed");
      }
    },
    authenticate: { realm: DASHBOARD_AUTH_REALM },
  });

  secured.after(() => {
    secured.addHook("onRequest", secured.basicAuth);
  });
}
