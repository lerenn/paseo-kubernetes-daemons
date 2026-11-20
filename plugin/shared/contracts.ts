import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { bundleSchema } from "./settings.js";
export const nameSchema = z
  .string()
  .max(50)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
export const requestSchema = z.object({ name: nameSchema });
export const createEnvironment = defineRpc({
  name: "environment.create",
  input: requestSchema,
  output: z.unknown(),
});
export const listEnvironments = defineRpc({
  name: "environment.list",
  input: z.object({}),
  output: z.unknown(),
});
export const releaseEnvironment = defineRpc({
  name: "environment.release",
  input: requestSchema,
  output: z.unknown(),
});
export const inspectSetup = defineRpc({
  name: "setup.inspect",
  input: z.object({}),
  output: z.object({
    context: z.string(),
    namespace: z.string(),
    operator: z.enum(["ready", "missing", "unavailable"]),
    message: z.string(),
  }),
});
export const discoverSources = defineRpc({
  name: "credentials.discover",
  input: z.object({ repositoryPath: z.string().max(4096).default("") }),
  output: z.object({
    providers: z.array(
      z.object({ id: z.string(), label: z.string(), available: z.boolean() }),
    ),
    mcps: z.array(
      z.object({
        name: z.string(),
        transport: z.string(),
        environment: z.array(z.string()),
        missing: z.array(z.string()),
        needsUrl: z.boolean(),
      }),
    ),
    oauthFile: z.boolean(),
    repositoryUrl: z.string(),
  }),
});
export const syncSelection = z
  .object({
    providers: z
      .array(
        z.enum([
          "codex-login",
          "openai-key",
          "anthropic-key",
          "gemini-key",
          "github-token",
        ]),
      )
      .max(5),
    mcps: z.array(z.string().min(1).max(200)).max(100),
    repositoryPath: z.string().max(4096).default(""),
    trustRepository: z.boolean().default(false),
    revision: z.string().max(250).default(""),
    mcpUrls: z.record(z.string(), z.string().url()).default({}),
    includeMcpOAuthFile: z.boolean().default(false),
  })
  .refine(
    (v) =>
      !(
        v.providers.includes("codex-login") &&
        v.providers.includes("openai-key")
      ),
    {
      message:
        "Choose either the Codex subscription login or an OpenAI API key, not both.",
    },
  );
// Only references/metadata leave the daemon; credential bytes never cross a plugin RPC.
export const syncCredentials = defineRpc({
  name: "credentials.sync",
  input: syncSelection,
  output: bundleSchema,
});
export const openEnvironment = defineRpc({
  name: "environment.open",
  input: requestSchema,
  output: z.object({ workspaceId: z.string(), serverId: z.string() }),
});
