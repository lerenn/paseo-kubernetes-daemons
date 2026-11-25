import type { PaseoProviderSnapshotResult } from "@getpaseo/client";
import { scopeOf, type Configuration } from "../shared/settings.js";
import type { Kubectl } from "./kubernetes.js";
import {
  buildCatalog,
  effectiveProjects,
  readCatalog,
  writeCatalog,
  type SyncedNames,
} from "./catalog.js";
import {
  ownerOf,
  projectId,
  syncProject,
  syncProviders,
  type ProviderSelection,
  type SourceOptions,
} from "./credentials.js";

export interface ProviderContext {
  snapshot: PaseoProviderSnapshotResult;
  controls: Record<string, unknown>;
}
export interface MigrationDeps {
  serverId: string;
  run: Kubectl;
  options?: SourceOptions;
  // Provider snapshot and controls from the main daemon; only called when a split sync is needed.
  providerContext: (selection: ProviderSelection) => Promise<ProviderContext>;
}
export interface Status {
  operator: "ready" | "missing" | "unavailable";
  crdCurrent: boolean;
}

// The legacy bundle (or the saved providers selection) as the shared provider selection.
export function selectionOf(c: Configuration): ProviderSelection | null {
  const b = c.bundle;
  if (b && b.scope === scopeOf(c))
    return {
      providers: b.providers as ProviderSelection["providers"],
      mcps: b.mcps,
      mcpUrls: c.providers.mcpUrls,
      includeMcpOAuthFile: c.providers.includeMcpOAuthFile,
      codexMode: c.providers.codexMode,
    };
  if (c.providers.selected.length || c.providers.mcps.length)
    return {
      providers: c.providers.selected,
      mcps: c.providers.mcps,
      mcpUrls: c.providers.mcpUrls,
      includeMcpOAuthFile: c.providers.includeMcpOAuthFile,
      codexMode: c.providers.codexMode,
    };
  return null;
}

// Runs after the operator upgrade, from setup.inspect. Idempotent and never throws: the catalog
// ends up with synced entries when the split succeeds, with legacy entries otherwise. The catalog is
// always written last, so a partial failure keeps the previous one. Settings are not written here
// (the server cannot); the cluster catalog is the state that marks a project as split.
export async function reconcile(
  c: Configuration,
  status: Status,
  deps: MigrationDeps,
  force?: { selection: ProviderSelection },
): Promise<{ migrated: boolean; error?: string }> {
  if (status.operator !== "ready") return { migrated: false };
  const owner = ownerOf(deps.serverId, c);
  const projects = effectiveProjects(c).filter((p) => p.trusted);
  const selection = force?.selection ?? selectionOf(c);
  let synced: Record<string, SyncedNames> | undefined;
  let error: string | undefined;
  let migrated = false;
  try {
    if (status.crdCurrent && selection && projects.length) {
      const existing = await readCatalog(deps.run);
      const done = existing.some((e) => e.providers);
      if (!done || force) {
        const context = await deps.providerContext(selection);
        const set = await syncProviders(
          c,
          selection,
          deps.serverId,
          deps.run,
          deps.options,
          context.snapshot,
          context.controls,
        );
        synced = {};
        for (const p of projects) {
          const result = await syncProject(
            c,
            {
              repository: p.repository,
              path: p.path,
              trusted: p.trusted,
              revision: p.revision,
              providerSubset: p.providerSubset,
              // Project-level MCPs need a checkout; a path-less project has none.
              projectMcps: p.path ? p.projectMcps : [],
              mcpUrls: selection.mcpUrls,
            },
            set,
            deps.serverId,
            deps.run,
            deps.options,
          );
          synced[projectId(p.repository)] = {
            profile: result.name,
            providerSet: set.name,
          };
        }
        migrated = true;
      } else {
        return { migrated: false };
      }
    }
  } catch (e) {
    synced = undefined;
    migrated = false;
    error = e instanceof Error ? e.message : "The provider split failed.";
  }
  try {
    await writeCatalog(
      deps.run,
      owner,
      c.namespace,
      buildCatalog(c, { crdCurrent: status.crdCurrent, synced }),
    );
  } catch (e) {
    error ??= e instanceof Error ? e.message : "The catalog could not be written.";
  }
  return { migrated, ...(error ? { error } : {}) };
}
