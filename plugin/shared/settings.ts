import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { podsSchema, podsOverrideSchema } from "./pods.js";
export const resourceName = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
export const bundleSchema = z.object({
  name: resourceName,
  scope: z.string(),
  syncedAt: z.string(),
  providers: z.array(z.string()),
  mcps: z.array(z.string()),
  repository: z.string(),
  gatewayReady: z.boolean().default(false),
});
// Keep in step with plugin/package.json: releases publish paseo-workspace:<version>.
export const DEFAULT_WORKSPACE_IMAGE = "ghcr.io/lerenn/paseo-workspace:0.4.1";
export const providerId = z.enum([
  "codex-login",
  "openai-key",
  "anthropic-key",
  "claude-login",
  "claude-token",
  "gemini-key",
  "github-token",
]);
// A selectable provider: a credential id, or "profile:<id>" for a user-defined provider profile
// (a custom provider of the main daemon that extends a built-in one).
export const profileRef = z.string().regex(/^profile:[A-Za-z0-9_-]{1,64}$/);
export const providerRef = z.union([providerId, profileRef]);
// Provider selection shared by every project (design: docs/design/projects-tab.md section 1).
// No credential values are stored; they are re-read from the main daemon at each sync.
export const providersSchema = z.object({
  selected: z.array(providerRef).max(40).default([]),
  mcps: z.array(z.string().min(1).max(200)).max(100).default([]),
  mcpUrls: z.record(z.string(), z.string()).default({}),
  // Reachable replacements for loopback URLs in profile env, keyed "<profile id>/<ENV NAME>".
  profileUrls: z.record(z.string(), z.string()).default({}),
  includeMcpOAuthFile: z.boolean().default(false),
  codexMode: z.enum(["access-only", "refreshing"]).default("access-only"),
  // Same trade-off for the Claude subscription login (claude-login), see docs/setup.md.
  claudeMode: z.enum(["access-only", "refreshing"]).default("access-only"),
  lastSync: z
    .object({ at: z.string(), version: z.string(), error: z.string().optional() })
    .nullable()
    .default(null),
});
export const projectSchema = z.object({
  // Informational: the server derives the id from the repository URL (catalog.ts projectId).
  id: z.string().max(64).default(""),
  repository: z.string().max(2000),
  path: z.string().max(4096).optional(),
  trusted: z.boolean().default(false),
  revision: z.string().max(250).default(""),
  providerSubset: z.array(providerRef).nullable().default(null),
  projectMcps: z.array(z.string().min(1).max(200)).max(100).default([]),
  overrides: z
    .object({
      image: z.string().max(500).optional(),
      docker: z.boolean().optional(),
      ephemeral: z.boolean().optional(),
      // Partial pod settings; absent fields use settings.pods.
      pods: podsOverrideSchema.optional(),
    })
    .default({}),
  synced: z
    .object({ profile: resourceName, providerSet: resourceName, at: z.string() })
    .nullable()
    .default(null),
});
export type Project = z.output<typeof projectSchema>;
// A plugin to install in every pod daemon, added explicitly by the user (never copied from the main
// daemon). `source` is what `paseo plugin install` accepts (registry slug, git:owner/repo, npm:pkg, URL);
// `ref` pins a Git branch, tag or commit. `env` values are secrets handed to the plugin as environment
// variables through a Secret; they are never returned by an RPC.
export const pluginSource = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\/:@+#~-]*$/, "Use a plugin source without whitespace or option prefixes.");
export const pluginRef = z
  .string()
  .max(250)
  .refine((v) => v === "" || (/^[A-Za-z0-9][A-Za-z0-9._\/@+-]*$/.test(v) && !v.includes("..")), {
    message: "Use a branch, tag or commit name without whitespace or option prefixes.",
  });
export const pluginEnv = z
  .record(z.string().max(253).regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192))
  .refine((v) => Object.keys(v).length <= 32, { message: "At most 32 variables per plugin." });
export const pluginSchema = z.object({
  source: pluginSource,
  ref: pluginRef.default(""),
  enabled: z.boolean().default(true),
  env: pluginEnv.default({}),
  // Set by the client from plugins.sync: the content digest that was synced and its config Secret.
  synced: z
    .object({ digest: z.string(), secret: resourceName.optional(), at: z.string() })
    .nullable()
    .default(null),
});
export type Plugin = z.output<typeof pluginSchema>;
export const settingsSchema = z.object({
  context: z.string().max(200).default(""),
  namespace: resourceName.default("paseo-workspaces"),
  clusterId: z.string().min(1).max(100).default("default"),
  image: z.string().max(500).default(DEFAULT_WORKSPACE_IMAGE),
  mainConnection: z.string().max(1000).default(""),
  // Public host:port (TLS) of the operator's virtual host, for clients outside the cluster.
  gatewayEndpoint: z.string().max(300).default(""),
  // Display name for the gateway host in the host picker. Empty uses "<daemon name> · Kubernetes".
  gatewayHostName: z.string().max(100).default(""),
  docker: z.boolean().default(false),
  ephemeral: z.boolean().default(true),
  // Global pod defaults (compute, storage, Docker sidecar); see shared/pods.ts.
  pods: podsSchema.default(podsSchema.parse({})),
  // Legacy full profile (settings v1). Kept until the split into provider set + project has run.
  bundle: bundleSchema.nullable().default(null),
  providers: providersSchema.default(providersSchema.parse({})),
  projects: z.array(projectSchema).max(100).default([]),
  plugins: z
    .array(pluginSchema)
    .max(16)
    .default([])
    .refine((v) => new Set(v.map((p) => p.source + "\0" + p.ref)).size === v.length, {
      message: "Each plugin source and ref can only be added once.",
    }),
});
export type Configuration = z.output<typeof settingsSchema>;
// v1 -> v2, data only: the saved bundle becomes the shared provider selection plus one project.
// The bundle is kept so the legacy profile stays usable until the split sync has succeeded.
export function migrateV1(values: unknown) {
  const old = (values && typeof values === "object" ? values : {}) as Record<
    string,
    unknown
  >;
  const parsed = bundleSchema.safeParse(old.bundle);
  if (!parsed.success) return old;
  const b = parsed.data;
  const providers = providersSchema.parse({
    selected: b.providers.filter((p) => providerId.safeParse(p).success),
    mcps: b.mcps,
  });
  const projects = b.repository
    ? [
        projectSchema.parse({
          repository: b.repository,
          trusted: true,
          overrides: {},
        }),
      ]
    : [];
  return { ...old, providers, projects };
}
export const workspaceSettings = defineSettings({
  id: "workspace-setup",
  scope: "host",
  version: 2,
  schema: settingsSchema,
  migrate: (values, fromVersion) =>
    fromVersion < 2 ? migrateV1(values) : values,
});
export function scopeOf(c: Configuration) {
  return JSON.stringify([c.context, c.clusterId, c.namespace]);
}
