import type { PaseoProviderSnapshotResult } from "@getpaseo/client";
import type { Configuration, Project } from "../shared/settings.js";
import { inspect, type Kubectl } from "./kubernetes.js";
import {
  buildCatalog,
  effectiveProjects,
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
  // Raw `providers` record of the main daemon config (profile definitions, secrets included).
  daemonProviders?: Record<string, unknown>;
}
export interface SyncDeps {
  serverId: string;
  run: Kubectl;
  options?: SourceOptions;
  // Provider snapshot and controls from the main daemon; only called when a provider set is written.
  providerContext: (selection: ProviderSelection) => Promise<ProviderContext>;
}
export interface Status {
  operator: "ready" | "missing" | "unavailable";
  crdCurrent: boolean;
}
export interface SetInfo {
  name: string;
  providers: string[];
  mcps: string[];
  profileDigests: Record<string, string>;
}
export interface ProjectResult {
  id: string;
  repository: string;
  // Present only when this run wrote a fresh profile. The client saves it into settings.
  synced: { profile: string; providerSet: string; at: string } | null;
  error?: string;
  skipped?: "unapproved";
}
export interface CatalogResult {
  written: boolean;
  entries: number;
  error?: string;
}

export const providerSelection = (c: Configuration): ProviderSelection => ({
  providers: c.providers.selected,
  mcps: c.providers.mcps,
  mcpUrls: c.providers.mcpUrls,
  profileUrls: c.providers.profileUrls,
  includeMcpOAuthFile: c.providers.includeMcpOAuthFile,
  codexMode: c.providers.codexMode,
  claudeMode: c.providers.claudeMode,
});

// Nothing is written to a cluster whose operator or CRD cannot honour provider sets.
export async function requireCurrent(c: Configuration, run: Kubectl) {
  const status = await inspect(c, run);
  if (status.operator !== "ready")
    throw new Error(
      "The operator is not ready. Run Check connection before syncing.",
    );
  if (!status.crdCurrent)
    throw new Error(
      "The CRD or operator is out of date: apply config/crd.yaml and upgrade the operator, then sync.",
    );
  return status;
}

// Reads the (secret-free) ConfigMap of a synced provider set; null when it does not exist.
export async function readProviderSet(
  run: Kubectl,
  name: string,
): Promise<SetInfo | null> {
  let raw = "";
  try {
    raw = await run([
      "get",
      "configmap",
      name,
      "--ignore-not-found",
      "-o",
      "jsonpath={.data.providers\\.json}",
    ]);
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return {
      name,
      providers: Array.isArray(v.providers) ? v.providers : [],
      mcps: Array.isArray(v.mcps) ? v.mcps : [],
      profileDigests:
        v.profileDigests && typeof v.profileDigests === "object" ? v.profileDigests : {},
    };
  } catch {
    return null;
  }
}

export function projectInput(c: Configuration, p: Project) {
  return {
    repository: p.repository,
    path: p.path,
    trusted: p.trusted,
    revision: p.revision,
    providerSubset: p.providerSubset,
    // Project-level MCPs need a checkout; a path-less project has none.
    projectMcps: p.path ? p.projectMcps : [],
    mcpUrls: c.providers.mcpUrls,
  };
}

// Writes the thin profile of each approved project against `set`. A project that fails keeps its
// previous state: it is left out of `synced`, so the catalog keeps pointing at its old pair.
export async function syncProjectsAgainst(
  c: Configuration,
  set: SetInfo,
  projects: Project[],
  deps: SyncDeps,
  at: string,
) {
  const synced: Record<string, SyncedNames> = {};
  const results: ProjectResult[] = [];
  for (const p of projects) {
    const id = projectId(p.repository);
    if (!p.trusted) {
      results.push({ id, repository: p.repository, synced: null, skipped: "unapproved" });
      continue;
    }
    try {
      const r = await syncProject(c, projectInput(c, p), set, deps.serverId, deps.run, deps.options);
      synced[id] = { profile: r.name, providerSet: set.name };
      results.push({
        id,
        repository: p.repository,
        synced: { profile: r.name, providerSet: set.name, at },
      });
    } catch (e) {
      results.push({
        id,
        repository: p.repository,
        synced: null,
        error: e instanceof Error ? e.message : "The project sync failed.",
      });
    }
  }
  return { synced, results };
}

// The catalog is always written last: any earlier failure leaves the previous catalog in place.
export async function publishCatalog(
  c: Configuration,
  deps: SyncDeps,
  status: Status,
  synced?: Record<string, SyncedNames>,
): Promise<CatalogResult> {
  try {
    const entries = buildCatalog(c, { crdCurrent: status.crdCurrent, synced });
    await writeCatalog(deps.run, ownerOf(deps.serverId, c), c.namespace, entries);
    return { written: true, entries: entries.length };
  } catch (e) {
    return {
      written: false,
      entries: 0,
      error: e instanceof Error ? e.message : "The catalog could not be written.",
    };
  }
}

export function assertSelection(selection: ProviderSelection) {
  if (
    selection.providers.includes("codex-login") &&
    selection.providers.includes("openai-key")
  )
    throw new Error(
      "Choose either the Codex subscription login or an OpenAI API key, not both.",
    );
}

// Writes the provider set from the saved selection, then every approved project against it.
// A failing set throws before anything else changes; a failing project only keeps its old state.
export async function splitAll(
  c: Configuration,
  selection: ProviderSelection,
  deps: SyncDeps,
) {
  assertSelection(selection);
  const context = await deps.providerContext(selection);
  const set = await syncProviders(
    c,
    selection,
    deps.serverId,
    deps.run,
    deps.options,
    context.snapshot,
    context.controls,
    context.daemonProviders,
  );
  const at = new Date().toISOString();
  const projects = await syncProjectsAgainst(c, set, effectiveProjects(c), deps, at);
  return { set, at, ...projects };
}

export async function syncAllProviders(c: Configuration, deps: SyncDeps) {
  const status = await requireCurrent(c, deps.run);
  const { set, at, synced, results } = await splitAll(c, providerSelection(c), deps);
  const catalog = await publishCatalog(c, deps, status, synced);
  return {
    providerSet: { name: set.name, providers: set.providers, mcps: set.mcps, at },
    skippedProfiles: set.skippedProfiles,
    lastSync: { at, version: set.name },
    projects: results,
    catalog,
  };
}

// One project against the last synced provider set.
export async function syncOneProject(c: Configuration, id: string, deps: SyncDeps) {
  const project = effectiveProjects(c).find((p) => projectId(p.repository) === id);
  if (!project) throw new Error("Unknown project.");
  if (!project.trusted)
    throw new Error(
      "Approve this repository before exporting its project configuration.",
    );
  const version = c.providers.lastSync?.version;
  if (!version) throw new Error("Sync providers before syncing a project.");
  const status = await requireCurrent(c, deps.run);
  const set = await readProviderSet(deps.run, version);
  if (!set)
    throw new Error("The synced provider set is missing from the cluster. Sync providers again.");
  const at = new Date().toISOString();
  const { synced, results } = await syncProjectsAgainst(c, set, [project], deps, at);
  const [result] = results;
  if (result.error) throw new Error(result.error);
  const catalog = await publishCatalog(c, deps, status, synced);
  return { project: result, catalog };
}

// Rebuilds the catalog from saved settings (image/docker/ephemeral overrides, removed projects).
export async function refreshCatalog(c: Configuration, deps: SyncDeps) {
  const status = await requireCurrent(c, deps.run);
  const catalog = await publishCatalog(c, deps, status);
  if (!catalog.written) throw new Error(catalog.error);
  return catalog;
}
