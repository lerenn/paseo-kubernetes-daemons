import {
  projectSchema,
  scopeOf,
  type Configuration,
  type Project,
} from "../shared/settings.js";
import type { Kubectl } from "./kubernetes.js";
import {
  assertRevision,
  discover,
  discoverProject,
  projectId,
  repositoryUrl,
  syncProject,
  type SourceOptions,
} from "./credentials.js";
import { effectiveProjects } from "./catalog.js";
import { projectInput, readProviderSet, type SetInfo } from "./sync.js";

// Settings can only be written by the client, so every mutation here is a pure function from the
// saved settings to the next `projects` array. The client persists it with settings.save(), then
// calls projects.sync / projects.catalog to push it to the cluster.

const MAX_PROJECTS = 100;
const find = (c: Configuration, id: string) => {
  const p = c.projects.find((x) => projectId(x.repository) === id);
  if (!p) throw new Error("Unknown project.");
  return p;
};
const replace = (c: Configuration, p: Project, next: Project) =>
  c.projects.map((x) => (x === p ? next : x));

async function checkout(path: string, repository: string, o: SourceOptions) {
  const found = await discoverProject(path, o);
  if (found.repositoryUrl !== repository)
    throw new Error("The checkout's origin does not match the project repository.");
  return found;
}
async function assertProjectMcps(
  path: string | undefined,
  repository: string,
  names: string[],
  o: SourceOptions,
) {
  if (!names.length) return;
  if (!path) throw new Error("Project MCPs need a local checkout of the repository.");
  const found = await checkout(path, repository, o);
  const have = new Set(found.mcps.map((m) => m.name));
  for (const n of names)
    if (!have.has(n)) throw new Error("A selected project MCP no longer exists in the checkout.");
}
function assertSubset(c: Configuration, subset: string[] | null) {
  if (!subset) return;
  for (const id of subset)
    if (!c.providers.selected.includes(id as never))
      throw new Error(
        "A project can only use providers that are selected on the Providers tab.",
      );
}

export interface AddInput {
  repository?: string;
  path?: string;
  revision?: string;
}
export async function addProject(c: Configuration, input: AddInput, o: SourceOptions = {}) {
  if (!input.repository && !input.path)
    throw new Error("Give a repository URL or a local checkout.");
  let url = input.repository ? repositoryUrl(input.repository) : "";
  if (input.path) {
    const found = await discoverProject(input.path, o);
    if (url && url !== found.repositoryUrl)
      throw new Error("The checkout's origin does not match the repository URL.");
    url = found.repositoryUrl;
  }
  assertRevision(input.revision ?? "");
  // The gateway resolves a project by repository URL, so each URL can only appear once.
  if (effectiveProjects(c).some((p) => p.repository === url))
    throw new Error("This repository is already a project.");
  if (c.projects.length >= MAX_PROJECTS)
    throw new Error("At most 100 projects are supported.");
  const project = projectSchema.parse({
    id: projectId(url),
    repository: url,
    ...(input.path ? { path: input.path } : {}),
    trusted: false,
    revision: input.revision ?? "",
  });
  return { project, projects: [...c.projects, project] };
}

export interface UpdateInput {
  id: string;
  revision?: string;
  // Narrowing only: null = all selected providers.
  providerSubset?: string[] | null;
  projectMcps?: string[];
  // null clears the checkout / an override.
  path?: string | null;
  overrides?: { image?: string | null; docker?: boolean | null; ephemeral?: boolean | null };
}
export async function updateProject(c: Configuration, input: UpdateInput, o: SourceOptions = {}) {
  const p = find(c, input.id);
  const path = input.path === undefined ? p.path : (input.path ?? undefined);
  const revision = input.revision ?? p.revision;
  assertRevision(revision);
  const subset = input.providerSubset === undefined ? p.providerSubset : input.providerSubset;
  assertSubset(c, subset);
  const mcps = input.projectMcps ?? p.projectMcps;
  if (input.path || input.projectMcps) await assertProjectMcps(path, p.repository, mcps, o);
  const overrides: Record<string, unknown> = { ...p.overrides };
  for (const [k, v] of Object.entries(input.overrides ?? {}))
    if (v === null) delete overrides[k];
    else if (v !== undefined) overrides[k] = v;
  const next = projectSchema.parse({
    ...p,
    path,
    revision,
    providerSubset: subset,
    projectMcps: path ? mcps : [],
    overrides,
  });
  // The repository (and so the id) never changes here: a new URL is a new project.
  return { project: next, projects: replace(c, p, next) };
}

// Approval is explicit and tied to the exact repository URL; unapproving stops catalog export.
export async function approveProject(
  c: Configuration,
  input: { id: string; approved: boolean; projectMcps?: string[] },
  o: SourceOptions = {},
) {
  const p = find(c, input.id);
  const mcps = input.projectMcps ?? p.projectMcps;
  if (input.approved && input.projectMcps) await assertProjectMcps(p.path, p.repository, mcps, o);
  const next = projectSchema.parse({
    ...p,
    trusted: input.approved,
    projectMcps: p.path ? mcps : [],
  });
  return { project: next, projects: replace(c, p, next) };
}

export async function removeProject(c: Configuration, id: string, run: Kubectl) {
  const p = find(c, id);
  // Removing never deletes running workspaces or profile objects: it only drops the entry.
  const counts = await workspaceCounts(c, run).catch(() => null);
  return {
    projects: c.projects.filter((x) => x !== p),
    workspaces: counts ? (counts[id] ?? 0) : null,
  };
}

// ---- status for the UI ----

type Workspace = { spec?: { bootstrap?: { configMapName?: string } } };
// Workspaces per project id: their profile ConfigMap carries the project label, or is a known
// current/legacy profile. Lookups are bounded and failures just leave a workspace uncounted.
export async function workspaceCounts(c: Configuration, run: Kubectl) {
  const list = JSON.parse(
    await run(["get", "paseoworkspaces.workspaces.paseo.sh", "-o", "json"]),
  ) as { items: Workspace[] };
  const known = new Map<string, string>();
  for (const p of effectiveProjects(c))
    if (p.synced) known.set(p.synced.profile, projectId(p.repository));
  if (c.bundle && c.bundle.scope === scopeOf(c) && c.bundle.repository)
    known.set(c.bundle.name, projectId(c.bundle.repository));
  const counts: Record<string, number> = {};
  const names = new Set(
    list.items.map((w) => w.spec?.bootstrap?.configMapName).filter((n): n is string => !!n),
  );
  const resolved = new Map<string, string>();
  let lookups = 0;
  for (const n of names) {
    const id = known.get(n);
    if (id) resolved.set(n, id);
    else if (lookups++ < 50) {
      const label = await run([
        "get",
        "configmap",
        n,
        "--ignore-not-found",
        "-o",
        "jsonpath={.metadata.labels.workspaces\\.paseo\\.sh/project}",
      ]).catch(() => "");
      if (label.trim()) resolved.set(n, label.trim());
    }
  }
  for (const w of list.items) {
    const n = w.spec?.bootstrap?.configMapName;
    const id = n ? resolved.get(n) : undefined;
    if (id) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export type SyncState = "synced" | "out-of-date" | "not-synced" | "unapproved";

export async function projectsStatus(
  c: Configuration,
  serverId: string,
  run: Kubectl,
  o: SourceOptions = {},
) {
  const version = c.providers.lastSync?.version;
  const set: SetInfo | null = version ? await readProviderSet(run, version) : null;
  const counts = await workspaceCounts(c, run).catch(() => null);
  const projects = [];
  for (const p of effectiveProjects(c)) {
    const id = projectId(p.repository);
    let state: SyncState = !p.trusted ? "unapproved" : !p.synced ? "not-synced" : "synced";
    let error: string | undefined;
    if (state === "synced" && p.synced) {
      if (p.synced.providerSet !== version) state = "out-of-date";
      else if (set) {
        // Settings changed since the sync iff the content-addressed profile name would differ.
        try {
          const planned = await syncProject(
            c,
            projectInput(c, p),
            set,
            serverId,
            run,
            o,
            false,
          );
          if (planned.name !== p.synced.profile) state = "out-of-date";
        } catch (e) {
          state = "out-of-date";
          error = e instanceof Error ? e.message : undefined;
        }
      }
    }
    const selected = c.providers.selected.length;
    projects.push({
      id,
      repository: p.repository,
      path: p.path ?? null,
      trusted: p.trusted,
      revision: p.revision,
      providerSubset: p.providerSubset,
      // "All" when null, otherwise `n of total` for the badge.
      providers: { used: p.providerSubset ? p.providerSubset.length : selected, total: selected },
      projectMcps: p.projectMcps,
      overrides: p.overrides,
      state,
      synced: p.synced,
      workspaces: counts ? (counts[id] ?? 0) : null,
      ...(error ? { error } : {}),
    });
  }
  return { projects };
}

type RowState = "synced" | "not-synced" | "out-of-date" | "unknown" | "none";
export async function providersStatus(
  c: Configuration,
  run: Kubectl,
  o: SourceOptions = {},
) {
  const found = await discover("", o).catch(() => null);
  const version = c.providers.lastSync?.version;
  let set: SetInfo | null = null;
  let clusterError: string | undefined;
  if (version) {
    set = await readProviderSet(run, version);
    if (!set) clusterError = "The synced provider set could not be read from the cluster.";
  }
  const state = (selected: boolean, inSet: boolean): RowState => {
    if (version && !set) return selected ? "unknown" : "none";
    if (!set) return selected ? "not-synced" : "none";
    if (selected) return inSet ? "synced" : "not-synced";
    return inSet ? "out-of-date" : "none";
  };
  const lastSync = c.providers.lastSync;
  const providers = (found?.providers ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    found: p.available,
    selected: c.providers.selected.includes(p.id as never),
    state: state(c.providers.selected.includes(p.id as never), !!set?.providers.includes(p.id)),
  }));
  const names = new Set([...(found?.mcps.map((m) => m.name) ?? []), ...c.providers.mcps]);
  const mcps = [...names].sort().map((name) => {
    const m = found?.mcps.find((x) => x.name === name);
    return {
      name,
      found: !!m,
      selected: c.providers.mcps.includes(name),
      needsUrl: m?.needsUrl ?? false,
      missing: m?.missing ?? [],
      state: state(c.providers.mcps.includes(name), !!set?.mcps.includes(name)),
    };
  });
  return {
    providers,
    mcps,
    oauthFile: found?.oauthFile ?? false,
    codexMode: c.providers.codexMode,
    includeMcpOAuthFile: c.providers.includeMcpOAuthFile,
    lastSync: lastSync ?? null,
    set: set ? { name: set.name, providers: set.providers, mcps: set.mcps } : null,
    ...(clusterError ? { clusterError } : {}),
  };
}
