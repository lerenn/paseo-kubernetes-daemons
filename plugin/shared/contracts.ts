import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { podsOverrideSchema, podsSchema } from "./pods.js";
import { bundleSchema, pluginEnv, pluginRef, pluginSchema, pluginSource, projectSchema, providerRef, providersSchema } from "./settings.js";
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
    // False when the installed CRD predates spec.bootstrap.providers: apply config/crd.yaml.
    crdCurrent: z.boolean().default(true),
    migrationError: z.string().optional(),
    // Set when this check split the legacy profile: the client saves it into settings
    // (providers.lastSync and each projects[].synced), since the server cannot write settings.
    split: z
      .object({
        providerSet: z.object({
          name: z.string(),
          providers: z.array(z.string()),
          mcps: z.array(z.string()),
          at: z.string(),
        }),
        lastSync: z.object({ at: z.string(), version: z.string() }),
        projects: z.array(z.lazy(() => projectResult)),
      })
      .optional(),
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

// ---- Providers and projects (design: docs/design/projects-tab.md sections 1, 4, 5) ----
// Settings are written only by the client. Read RPCs use the saved settings; mutating RPCs return the
// next value for the client to save (with settings.save and the current revision) and, for syncs,
// the names to store. Save settings first, then call a sync RPC. No credential bytes cross an RPC.
const rowState = z.enum(["synced", "not-synced", "out-of-date", "unknown", "none"]);
export const syncedSchema = z.object({
  profile: z.string(),
  providerSet: z.string(),
  at: z.string(),
});
export const projectResult = z.object({
  id: z.string(),
  repository: z.string(),
  // Present only when a fresh profile was written; save it as projects[].synced.
  synced: syncedSchema.nullable(),
  error: z.string().optional(),
  skipped: z.enum(["unapproved"]).optional(),
});
const catalogResult = z.object({
  written: z.boolean(),
  entries: z.number(),
  error: z.string().optional(),
});
export const providersStatus = defineRpc({
  name: "providers.status",
  input: z.object({}),
  output: z.object({
    // The main daemon's providers as the new-conversation picker lists them: built-ins and profiles.
    // Never carries env values, URLs with credentials or API keys.
    providers: z.array(
      z.object({
        id: z.string(),
        providerId: z.string(),
        label: z.string(),
        kind: z.enum(["builtin", "profile"]),
        base: z.string(),
        models: z.number().nullable(),
        found: z.boolean(),
        supported: z.boolean(),
        hint: z.string().optional(),
        needsUrls: z.array(z.object({ name: z.string(), host: z.string(), override: z.string() })),
        selected: z.boolean(),
        state: rowState,
      }),
    ),
    // Other credentials (extra API keys, GitHub token) that no provider row represents.
    credentials: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        found: z.boolean(),
        selected: z.boolean(),
        state: rowState,
      }),
    ),
    daemonError: z.string().optional(),
    mcps: z.array(
      z.object({
        name: z.string(),
        found: z.boolean(),
        selected: z.boolean(),
        needsUrl: z.boolean(),
        missing: z.array(z.string()),
        state: rowState,
      }),
    ),
    oauthFile: z.boolean(),
    codexMode: providersSchema.shape.codexMode,
    claudeMode: providersSchema.shape.claudeMode,
    includeMcpOAuthFile: z.boolean(),
    lastSync: providersSchema.shape.lastSync,
    set: z
      .object({ name: z.string(), providers: z.array(z.string()), mcps: z.array(z.string()) })
      .nullable(),
    clusterError: z.string().optional(),
  }),
});
// Syncs the provider set from the saved settings, then every approved project against it. Throws when
// the set cannot be written (nothing changed). A failing project keeps its old state: see projects[].error.
export const providersSync = defineRpc({
  name: "providers.sync",
  input: z.object({}),
  output: z.object({
    // Selected profiles that could not be exported (the sync still succeeded).
    skippedProfiles: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
    providerSet: z.object({
      name: z.string(),
      providers: z.array(z.string()),
      mcps: z.array(z.string()),
      at: z.string(),
    }),
    // Save as settings.providers.lastSync.
    lastSync: z.object({ at: z.string(), version: z.string() }),
    projects: z.array(projectResult),
    catalog: catalogResult,
  }),
});
const status = z.enum(["synced", "out-of-date", "not-synced", "unapproved"]);
export const projectsList = defineRpc({
  name: "projects.list",
  input: z.object({}),
  output: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        repository: z.string(),
        path: z.string().nullable(),
        trusted: z.boolean(),
        revision: z.string(),
        providerSubset: z.array(providerRef).nullable(),
        providers: z.object({ used: z.number(), total: z.number() }),
        projectMcps: z.array(z.string()),
        overrides: projectSchema.shape.overrides,
        state: status,
        synced: syncedSchema.nullable(),
        // Null when the cluster could not be read.
        workspaces: z.number().nullable(),
        error: z.string().optional(),
      }),
    ),
  }),
});
// For the approval dialog: the origin URL and the MCP servers only that checkout defines.
export const projectsDiscover = defineRpc({
  name: "projects.discover",
  input: z.object({ path: z.string().min(1).max(4096) }),
  output: z.object({
    repositoryUrl: z.string(),
    mcps: z.array(
      z.object({
        name: z.string(),
        transport: z.string(),
        environment: z.array(z.string()),
        missing: z.array(z.string()),
        needsUrl: z.boolean(),
      }),
    ),
  }),
});
// Projects Paseo knows on this daemon, with their status against the plugin's projects.
export const projectsDiscoverLocal = defineRpc({
  name: "projects.discover-local",
  input: z.object({}),
  output: z.object({
    candidates: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        id: z.string().nullable(),
        repository: z.string().nullable(),
        host: z.string().nullable(),
        status: z.enum(["not-added", "unapproved", "not-synced", "synced", "skipped"]),
        reason: z.string().optional(),
      }),
    ),
    truncated: z.boolean(),
  }),
});
const nextProjects = z.object({
  project: projectSchema,
  // The whole next settings.projects value.
  projects: z.array(projectSchema),
});
export const projectsAdd = defineRpc({
  name: "projects.add",
  input: z.object({
    repository: z.string().max(2000).optional(),
    path: z.string().max(4096).optional(),
    revision: z.string().max(250).optional(),
  }),
  output: nextProjects,
});
export const projectsUpdate = defineRpc({
  name: "projects.update",
  input: z.object({
    id: z.string(),
    revision: z.string().max(250).optional(),
    providerSubset: z.array(providerRef).nullable().optional(),
    projectMcps: z.array(z.string().min(1).max(200)).max(100).optional(),
    path: z.string().max(4096).nullable().optional(),
    overrides: z
      .object({
        image: z.string().max(500).nullable().optional(),
        docker: z.boolean().nullable().optional(),
        ephemeral: z.boolean().nullable().optional(),
        // null removes the project's pod overrides.
        pods: podsOverrideSchema.nullable().optional(),
      })
      .optional(),
  }),
  output: nextProjects,
});
export const projectsApprove = defineRpc({
  name: "projects.approve",
  input: z.object({
    id: z.string(),
    approved: z.boolean().default(true),
    projectMcps: z.array(z.string().min(1).max(200)).max(100).optional(),
  }),
  output: nextProjects,
});
export const projectsRemove = defineRpc({
  name: "projects.remove",
  input: z.object({ id: z.string() }),
  output: z.object({
    projects: z.array(projectSchema),
    // Running workspaces stay untouched; null when the cluster could not be read.
    workspaces: z.number().nullable(),
  }),
});
// Writes the thin profile of one approved project against the last synced provider set.
export const projectsSync = defineRpc({
  name: "projects.sync",
  input: z.object({ id: z.string() }),
  output: z.object({ project: projectResult, catalog: catalogResult }),
});
// Rebuilds the catalog from saved settings: instant for image/docker/ephemeral overrides and removals.
export const projectsCatalog = defineRpc({
  name: "projects.catalog",
  input: z.object({}),
  output: catalogResult,
});

const podsIssue = z.object({ path: z.string(), message: z.string() });
const podsEstimate = z.object({
  requests: z.object({ cpu: z.number(), memory: z.number(), scratch: z.number() }),
  limits: z.object({ cpu: z.number(), memory: z.number(), scratch: z.number() }),
  storage: z.number(),
});
// Pod settings for the Pods tab. `builtin` are the values used when nothing is configured (also the
// initial settings.pods). `quotas` / `storageClasses` are null when the cluster cannot be read (RBAC or
// connectivity): the UI then degrades to free text and shows no capacity summary.
export const podsStatus = defineRpc({
  name: "pods.status",
  input: z.object({}),
  output: z.object({
    pods: podsSchema,
    builtin: podsSchema,
    issues: z.array(podsIssue),
    quotas: z.array(z.object({ name: z.string(), hard: z.record(z.string(), z.string()) })).nullable(),
    storageClasses: z
      .array(
        z.object({
          name: z.string(),
          isDefault: z.boolean(),
          allowVolumeExpansion: z.boolean(),
          provisioner: z.string(),
        }),
      )
      .nullable(),
  }),
});
// Validates candidate settings (global, optionally merged with a project override) without saving.
// Errors block saving; warnings come from the quota and storage classes and never block.
export const podsCheck = defineRpc({
  name: "pods.check",
  input: z.object({
    pods: podsSchema,
    override: podsOverrideSchema.optional(),
    docker: z.boolean().optional(),
    ephemeral: z.boolean().optional(),
  }),
  output: z.object({
    errors: z.array(podsIssue),
    warnings: z.array(z.string()),
    // One pod's total (workspace + Docker sidecar when enabled); cores / bytes.
    perPod: podsEstimate,
    // Pods the namespace quota admits; null when unconstrained or unreadable.
    fit: z.number().nullable(),
  }),
});

// ---- Plugins installed in every pod daemon ----
// Only user-added entries; env values are secrets and never leave the settings except into a Secret.
// Mutating RPCs return the next `plugins` value for the client to save; plugins.sync returns the
// `synced` values to store (save settings first, then sync, then save the results).
const pluginIdentity = { source: pluginSource, ref: pluginRef.default("") };
const pluginSynced = z.object({ digest: z.string(), secret: z.string().optional(), at: z.string() });
export const pluginsStatus = defineRpc({
  name: "plugins.status",
  input: z.object({}),
  output: z.object({
    plugins: z.array(
      z.object({
        source: z.string(),
        ref: z.string(),
        enabled: z.boolean(),
        envKeys: z.array(z.string()),
        state: z.enum(["synced", "out-of-date", "not-synced"]),
        synced: z.object({ at: z.string(), secret: z.string().optional() }).nullable(),
      }),
    ),
  }),
});
export const pluginsAdd = defineRpc({
  name: "plugins.add",
  input: z.object({ ...pluginIdentity, env: pluginEnv.optional() }),
  output: z.object({ plugin: pluginSchema, plugins: z.array(pluginSchema) }),
});
export const pluginsUpdate = defineRpc({
  name: "plugins.update",
  input: z.object({
    ...pluginIdentity,
    newRef: pluginRef.optional(),
    enabled: z.boolean().optional(),
    env: pluginEnv.optional(),
  }),
  output: z.object({ plugin: pluginSchema, plugins: z.array(pluginSchema) }),
});
export const pluginsRemove = defineRpc({
  name: "plugins.remove",
  input: z.object(pluginIdentity),
  output: z.object({ plugins: z.array(pluginSchema) }),
});
export const pluginsSync = defineRpc({
  name: "plugins.sync",
  input: z.object({}),
  output: z.object({
    plugins: z.array(
      z.object({
        source: z.string(),
        ref: z.string(),
        synced: pluginSynced.nullable(),
        skipped: z.enum(["disabled"]).optional(),
        error: z.string().optional(),
      }),
    ),
    catalog: catalogResult,
  }),
});
