import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
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
export const DEFAULT_WORKSPACE_IMAGE = "ghcr.io/lerenn/paseo-workspace:0.2.6";
export const providerId = z.enum([
  "codex-login",
  "openai-key",
  "anthropic-key",
  "gemini-key",
  "github-token",
]);
// Provider selection shared by every project (design: docs/design/projects-tab.md section 1).
// No credential values are stored; they are re-read from the main daemon at each sync.
export const providersSchema = z.object({
  selected: z.array(providerId).max(5).default([]),
  mcps: z.array(z.string().min(1).max(200)).max(100).default([]),
  mcpUrls: z.record(z.string(), z.string()).default({}),
  includeMcpOAuthFile: z.boolean().default(false),
  codexMode: z.enum(["access-only", "refreshing"]).default("access-only"),
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
  providerSubset: z.array(providerId).nullable().default(null),
  projectMcps: z.array(z.string().min(1).max(200)).max(100).default([]),
  overrides: z
    .object({
      image: z.string().max(500).optional(),
      docker: z.boolean().optional(),
      ephemeral: z.boolean().optional(),
    })
    .default({}),
  synced: z
    .object({ profile: resourceName, providerSet: resourceName, at: z.string() })
    .nullable()
    .default(null),
});
export type Project = z.output<typeof projectSchema>;
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
  // Legacy full profile (settings v1). Kept until the split into provider set + project has run.
  bundle: bundleSchema.nullable().default(null),
  providers: providersSchema.default(providersSchema.parse({})),
  projects: z.array(projectSchema).max(100).default([]),
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
