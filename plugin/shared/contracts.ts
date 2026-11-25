import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { bundleSchema, projectSchema, providerId, providersSchema } from "./settings.js";
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
    providers: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        found: z.boolean(),
        selected: z.boolean(),
        state: rowState,
      }),
    ),
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
        providerSubset: z.array(providerId).nullable(),
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
    providerSubset: z.array(providerId).nullable().optional(),
    projectMcps: z.array(z.string().min(1).max(200)).max(100).optional(),
    path: z.string().max(4096).nullable().optional(),
    overrides: z
      .object({
        image: z.string().max(500).nullable().optional(),
        docker: z.boolean().nullable().optional(),
        ephemeral: z.boolean().nullable().optional(),
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
