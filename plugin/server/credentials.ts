import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parse, stringify } from "smol-toml";
import type { z } from "zod";
import type { PaseoProviderSnapshotResult } from "@getpaseo/client";
import { providerProfile } from "./provider-profile.js";
import { syncSelection } from "../shared/contracts.js";
import { scopeOf, type Configuration } from "../shared/settings.js";
import { applyOwned, connection, type Kubectl } from "./kubernetes.js";
const exec = promisify(execFile);
const providerEnv = {
  "openai-key": "OPENAI_API_KEY",
  "anthropic-key": "ANTHROPIC_API_KEY",
  "gemini-key": "GEMINI_API_KEY",
  "github-token": "GITHUB_TOKEN",
} as const;
const labels = {
  "openai-key": "OpenAI API key",
  "anthropic-key": "Anthropic API key (Claude Code)",
  "gemini-key": "Gemini API key (install its provider in the image)",
  "github-token": "GitHub token for HTTPS repository checkout",
};
type Mcp = Record<string, unknown>;
export interface SourceOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
}
function codexHome(o: SourceOptions) {
  return o.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}
async function exists(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
async function text(file: string, optional = false) {
  try {
    const s = await stat(file);
    if (s.size > 700_000) throw new Error();
    return await readFile(file, "utf8");
  } catch {
    if (optional && !(await exists(file))) return "";
    throw new Error(
      "A credential/configuration file is unreadable or too large.",
    );
  }
}
function toml(input: string): Record<string, unknown> {
  try {
    return parse(input) as Record<string, unknown>;
  } catch {
    throw new Error(
      "Invalid Codex TOML configuration. Fix the source config before syncing.",
    );
  }
}
function mcpEntries(config: Record<string, unknown>) {
  const m = config.mcp_servers;
  if (m === undefined) return {};
  if (!m || typeof m !== "object" || Array.isArray(m))
    throw new Error("Invalid mcp_servers table.");
  return m as Record<string, Mcp>;
}
export function assertRevision(revision: string) {
  if (
    revision &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(revision) ||
      revision.includes(".."))
  )
    throw new Error(
      "Use a branch, tag or commit name without whitespace or option prefixes.",
    );
}
export function repositoryUrl(raw: string) {
  if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    if (
      !["https:", "ssh:"].includes(u.protocol) ||
      u.password ||
      (u.protocol === "https:" && u.username) ||
      u.search ||
      u.hash
    )
      throw new Error();
    return u.toString();
  } catch {
    throw new Error("Use a credential-free HTTPS or SSH Git repository URL.");
  }
}
async function sources(repositoryPath: string, o: SourceOptions) {
  const home = codexHome(o);
  const global = toml(await text(join(home, "config.toml"), true));
  let root = "",
    url = "",
    project: Record<string, unknown> = {};
  if (repositoryPath) {
    try {
      root = await realpath(repositoryPath);
      const result = await exec(
        "git",
        ["-C", root, "rev-parse", "--show-toplevel"],
        { timeout: 5000 },
      );
      root = result.stdout.trim();
      const origin = await exec(
        "git",
        ["-C", root, "remote", "get-url", "origin"],
        { timeout: 5000 },
      );
      url = repositoryUrl(origin.stdout.trim());
    } catch {
      throw new Error(
        "Repository must be a readable Git checkout with a credential-free HTTPS or SSH origin.",
      );
    }
    project = toml(await text(join(root, ".codex", "config.toml"), true));
  }
  return {
    home,
    root,
    url,
    mcps: { ...mcpEntries(global), ...mcpEntries(project) },
    // Servers defined only in the repository's own .codex/config.toml.
    projectOnly: mcpEntries(project),
  };
}
function environmentNames(m: Mcp): string[] {
  const result = new Set<string>();
  if (typeof m.bearer_token_env_var === "string")
    result.add(m.bearer_token_env_var);
  if (m.env_http_headers && typeof m.env_http_headers === "object")
    for (const val of Object.values(m.env_http_headers))
      if (typeof val === "string") result.add(val);
  if (Array.isArray(m.env_vars))
    for (const val of m.env_vars) {
      if (typeof val === "string") result.add(val);
      else if (val && typeof val.name === "string") result.add(val.name);
    }
  for (const name of result)
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      /^(HOME|CODEX_HOME|PASEO_.*|PATH|LD_.*|PYTHON.*|NODE_OPTIONS|GIT_CONFIG.*)$/.test(
        name,
      )
    )
      throw new Error("An MCP requests an unsupported environment variable.");
  return [...result].sort();
}
function loopback(url: unknown) {
  if (typeof url !== "string") return false;
  try {
    const h = new URL(url).hostname;
    return ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(h);
  } catch {
    return false;
  }
}
function mcpRow(name: string, m: Mcp, env: NodeJS.ProcessEnv) {
  const names = environmentNames(m);
  return {
    name,
    transport: typeof m.url === "string" ? "HTTP" : "STDIO",
    environment: names,
    missing: names.filter((k) => !env[k]),
    needsUrl: loopback(m.url),
  };
}
// A local checkout: its canonical origin URL and the MCP servers only that repository defines.
export async function discoverProject(path: string, o: SourceOptions = {}) {
  if (!path) throw new Error("Choose a repository checkout.");
  const s = await sources(path, o);
  const env = o.env ?? process.env;
  return {
    repositoryUrl: s.url,
    mcps: Object.entries(s.projectOnly).map(([n, m]) => mcpRow(n, m, env)),
  };
}
export async function discover(repositoryPath: string, o: SourceOptions = {}) {
  const s = await sources(repositoryPath, o);
  const env = o.env ?? process.env;
  let subscription = false;
  try {
    const auth = JSON.parse(await text(join(s.home, "auth.json")));
    subscription =
      typeof auth?.tokens?.access_token === "string" &&
      !!auth.tokens.access_token;
  } catch {
    /* unavailable or keychain-only */
  }
  return {
    providers: [
      {
        id: "codex-login",
        label: "Codex subscription login (file-backed)",
        available: subscription,
      },
      ...Object.entries(providerEnv).map(([id, key]) => ({
        id,
        label: labels[id as keyof typeof labels],
        available: !!env[key],
      })),
    ],
    mcps: Object.entries(s.mcps).map(([name, m]) => mcpRow(name, m, env)),
    oauthFile: await exists(join(s.home, ".credentials.json")),
    repositoryUrl: s.url,
  };
}
type Sources = Awaited<ReturnType<typeof sources>>;
// Exports the named MCP definitions for pods: URL overrides, no loopback endpoints, checkout paths
// translated to /workspace/repository, and the environment variables each one needs.
function exportMcps(
  names: Iterable<string>,
  s: Sources,
  env: NodeJS.ProcessEnv,
  mcpUrls: Record<string, string>,
) {
  const mcps: Record<string, Mcp> = Object.create(null);
  const mcpEnv: Record<string, string[]> = Object.create(null);
  for (const name of new Set(names)) {
    if (!Object.hasOwn(s.mcps, name))
      throw new Error(
        "A selected MCP no longer exists. Discover sources again.",
      );
    const m = structuredClone(s.mcps[name]);
    if (mcpUrls[name]) {
      const u = new URL(mcpUrls[name]);
      if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
        throw new Error(
          "MCP URL overrides must be HTTP(S) endpoints without embedded credentials.",
        );
      m.url = u.toString();
    }
    if (loopback(m.url))
      throw new Error(
        "Replace localhost MCP endpoints with a URL reachable from workspace pods.",
      );
    if (typeof m.cwd === "string" && s.root && m.cwd.startsWith(s.root + "/"))
      m.cwd = "/workspace/repository/" + m.cwd.slice(s.root.length + 1);
    else if (m.cwd === s.root && s.root) m.cwd = "/workspace/repository";
    if (
      typeof m.command === "string" &&
      s.root &&
      m.command.startsWith(s.root + "/")
    )
      m.command = "/workspace/repository/" + m.command.slice(s.root.length + 1);
    const required = environmentNames(m);
    for (const key of required)
      if (!env[key])
        throw new Error(
          `MCP environment variable ${key} is unavailable on the main daemon.`,
        );
    mcpEnv[name] = required;
    mcps[name] = m;
  }
  return { mcps, mcpEnv };
}
export async function bundle(
  selection: z.output<typeof syncSelection>,
  o: SourceOptions = {},
) {
  const s = await sources(selection.repositoryPath, o);
  const env = o.env ?? process.env;
  if (selection.repositoryPath && !selection.trustRepository)
    throw new Error(
      "Approve this repository before exporting its project configuration.",
    );
  if (
    selection.revision &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/@+-]*$/.test(selection.revision) ||
      selection.revision.includes(".."))
  )
    throw new Error(
      "Use a branch, tag or commit name without whitespace or option prefixes.",
    );
  const files: Record<string, string> = {};
  const vars: Record<string, string> = {};
  if (selection.providers.includes("codex-login")) {
    const raw = await text(join(s.home, "auth.json"));
    try {
      const v = JSON.parse(raw);
      if (typeof v?.tokens?.access_token !== "string" || !v.tokens.access_token)
        throw new Error();
    } catch {
      throw new Error(
        "A file-backed Codex subscription login is required. Log in on the main host first.",
      );
    }
    files["auth.json"] = raw;
  }
  for (const provider of selection.providers) {
    if (provider === "codex-login") continue;
    const key = providerEnv[provider];
    if (!env[key])
      throw new Error(
        `Selected credential ${key} is unavailable on the main daemon.`,
      );
    vars[key] = env[key]!;
  }
  const { mcps, mcpEnv } = exportMcps(selection.mcps, s, env, selection.mcpUrls);
  for (const names of Object.values(mcpEnv))
    for (const key of names) vars[key] = env[key]!;
  const config: Record<string, unknown> = {
    cli_auth_credentials_store: "file",
    mcp_oauth_credentials_store: "file",
    mcp_servers: mcps,
  };
  if (s.url)
    config.projects = { "/workspace/repository": { trust_level: "trusted" } };
  files["config.toml"] = stringify(config as Parameters<typeof stringify>[0]);
  if (selection.includeMcpOAuthFile) {
    if (!selection.mcps.length)
      throw new Error("Select an MCP before exporting its OAuth cache.");
    const raw = await text(join(s.home, ".credentials.json"));
    try {
      JSON.parse(raw);
    } catch {
      throw new Error("The MCP OAuth cache is invalid.");
    }
    files[".credentials.json"] = raw;
  }
  return {
    files,
    environment: vars,
    bootstrap: {
      repository: s.url ? { url: s.url, revision: selection.revision } : null,
      providers: selection.providers,
      mcps: selection.mcps,
      trustRepository: selection.trustRepository,
    },
  };
}
export async function sync(
  c: Configuration,
  selection: z.output<typeof syncSelection>,
  serverId: string,
  run: Kubectl = connection(c),
  o: SourceOptions = {},
  snapshot?: PaseoProviderSnapshotResult,
  controls: Record<string, unknown> = {},
) {
  if (!c.context) {
    const current = await run(["config", "current-context"]).catch(() => "");
    if (current.trim())
      throw new Error(
        "Save an explicit Kubernetes context before syncing credentials.",
      );
  }
  const data = await bundle(selection, o);
  const discovery = snapshot ? providerProfile(snapshot, selection.providers) : [];
  const owner = createHash("sha256")
    .update(JSON.stringify([serverId, scopeOf(c)]))
    .digest("hex")
    .slice(0, 16);
  const version = createHash("sha256")
    .update(JSON.stringify({data, discovery, controls}))
    .digest("hex")
    .slice(0, 20);
  const name = `pw-profile-${owner}-${version}`;
  const meta = {
    name,
    namespace: c.namespace,
    labels: { "workspaces.paseo.sh/profile-owner": owner },
  };
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: meta,
    type: "Opaque",
    immutable: true,
    data: {
      "files.json": Buffer.from(JSON.stringify(data.files)).toString("base64"),
    },
  };
  const envSecret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { ...meta, name: name + "-env" },
    type: "Opaque",
    immutable: true,
    data: Object.fromEntries(
      Object.entries(data.environment).map(([k, v]) => [
        k,
        Buffer.from(v).toString("base64"),
      ]),
    ),
  };
  const config = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: meta,
    immutable: true,
    data: { "bootstrap.json": JSON.stringify({...data.bootstrap, providerSnapshot: discovery, providerControls: controls}) },
  };
  if (
    Buffer.byteLength(JSON.stringify(secret)) +
      Buffer.byteLength(JSON.stringify(envSecret)) >
    900_000
  )
    throw new Error("Selected credentials exceed the profile size limit.");
  await applyOwned(run, secret, owner);
  await applyOwned(run, envSecret, owner);
  await applyOwned(run, config, owner);
  return {
    name,
    scope: scopeOf(c),
    syncedAt: new Date().toISOString(),
    providers: selection.providers,
    mcps: selection.mcps,
    repository: data.bootstrap.repository?.url ?? "",
    gatewayReady: true,
  };
}

// ---- Shared provider set + thin project profile (design: docs/design/projects-tab.md sections 1-2) ----
export const OWNER_LABEL = "workspaces.paseo.sh/profile-owner";
export function ownerOf(serverId: string, c: Configuration) {
  return createHash("sha256")
    .update(JSON.stringify([serverId, scopeOf(c)]))
    .digest("hex")
    .slice(0, 16);
}
// Matches the gateway's project id (hex of the first 16 bytes of sha256(url)).
export function projectId(repository: string) {
  return createHash("sha256").update(repository).digest("hex").slice(0, 32);
}
const b64 = (v: string) => Buffer.from(v).toString("base64");
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 20);
const LIMIT = 900_000;
// Writes Secret, env Secret and ConfigMap, all immutable and content-addressed. The ConfigMap is last.
async function applyTriple(
  run: Kubectl,
  owner: string,
  namespace: string,
  name: string,
  extra: Record<string, string>,
  files: Record<string, string>,
  environment: Record<string, string>,
  configData: Record<string, string>,
) {
  const meta = {
    name,
    namespace,
    labels: { [OWNER_LABEL]: owner, ...extra },
  };
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: meta,
    type: "Opaque",
    immutable: true,
    data: { "files.json": b64(JSON.stringify(files)) },
  };
  const envSecret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { ...meta, name: name + "-env" },
    type: "Opaque",
    immutable: true,
    data: Object.fromEntries(
      Object.entries(environment).map(([k, v]) => [k, b64(v)]),
    ),
  };
  const config = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: meta,
    immutable: true,
    data: configData,
  };
  if (
    Buffer.byteLength(JSON.stringify(secret)) +
      Buffer.byteLength(JSON.stringify(envSecret)) >
    LIMIT
  )
    throw new Error("Selected credentials exceed the profile size limit.");
  await applyOwned(run, secret, owner);
  await applyOwned(run, envSecret, owner);
  await applyOwned(run, config, owner);
}
export interface ProviderSelection {
  providers: z.output<typeof syncSelection>["providers"];
  mcps: string[];
  mcpUrls: Record<string, string>;
  includeMcpOAuthFile: boolean;
  codexMode: "access-only" | "refreshing";
}
export async function syncProviders(
  c: Configuration,
  selection: ProviderSelection,
  serverId: string,
  run: Kubectl = connection(c),
  o: SourceOptions = {},
  snapshot?: PaseoProviderSnapshotResult,
  controls: Record<string, unknown> = {},
) {
  const s = await sources("", o);
  const env = o.env ?? process.env;
  const files: Record<string, string> = {};
  const vars: Record<string, string> = {};
  if (selection.providers.includes("codex-login")) {
    const raw = await text(join(s.home, "auth.json"));
    try {
      const v = JSON.parse(raw);
      if (typeof v?.tokens?.access_token !== "string" || !v.tokens.access_token)
        throw new Error();
      // access-only: pods can use the access token but never rotate the refresh token. Codex
      // rejects a missing key but accepts an empty string, so blank it rather than delete it.
      if (selection.codexMode === "access-only") v.tokens.refresh_token = "";
      files["auth.json"] =
        selection.codexMode === "access-only" ? JSON.stringify(v) : raw;
    } catch {
      throw new Error(
        "A file-backed Codex subscription login is required. Log in on the main host first.",
      );
    }
  }
  for (const provider of selection.providers) {
    if (provider === "codex-login") continue;
    const key = providerEnv[provider];
    if (!env[key])
      throw new Error(
        `Selected credential ${key} is unavailable on the main daemon.`,
      );
    vars[key] = env[key]!;
  }
  const { mcps, mcpEnv } = exportMcps(selection.mcps, s, env, selection.mcpUrls);
  for (const names of Object.values(mcpEnv))
    for (const key of names) vars[key] = env[key]!;
  files["config.toml"] = stringify({
    cli_auth_credentials_store: "file",
    mcp_oauth_credentials_store: "file",
    mcp_servers: mcps,
  } as Parameters<typeof stringify>[0]);
  if (selection.includeMcpOAuthFile) {
    if (!selection.mcps.length)
      throw new Error("Select an MCP before exporting its OAuth cache.");
    const raw = await text(join(s.home, ".credentials.json"));
    try {
      JSON.parse(raw);
    } catch {
      throw new Error("The MCP OAuth cache is invalid.");
    }
    files[".credentials.json"] = raw;
  }
  const discovery = snapshot ? providerProfile(snapshot, selection.providers) : [];
  const owner = ownerOf(serverId, c);
  const meta = {
    providers: selection.providers,
    mcps: [...new Set(selection.mcps)],
    mcpEnv,
  };
  const name = `pw-providers-${owner}-${digest({ files, vars, meta, discovery, controls })}`;
  await applyTriple(
    run,
    owner,
    c.namespace,
    name,
    { "workspaces.paseo.sh/kind": "providers" },
    files,
    vars,
    {
      "providers.json": JSON.stringify({
        ...meta,
        providerSnapshot: discovery,
        providerControls: controls,
      }),
    },
  );
  return { name, owner, ...meta };
}
export interface ProjectSync {
  repository: string;
  // Optional local checkout: the only source of project-level MCPs and of the canonical origin URL.
  path?: string;
  trusted: boolean;
  revision: string;
  providerSubset: string[] | null;
  // Optional subset of the provider set's MCP servers; null = all.
  mcpSubset?: string[] | null;
  projectMcps: string[];
  mcpUrls?: Record<string, string>;
}
export async function syncProject(
  c: Configuration,
  project: ProjectSync,
  providerSet: { providers: string[]; mcps: string[] },
  serverId: string,
  run: Kubectl = connection(c),
  o: SourceOptions = {},
  // False computes the content-addressed names without touching the cluster (staleness checks).
  write = true,
) {
  if (!project.trusted)
    throw new Error(
      "Approve this repository before exporting its project configuration.",
    );
  assertRevision(project.revision);
  const url = repositoryUrl(project.repository);
  if (project.providerSubset)
    for (const id of project.providerSubset)
      if (!providerSet.providers.includes(id))
        throw new Error(
          "A project can only use providers that are part of the synced provider set.",
        );
  if (project.mcpSubset)
    for (const m of project.mcpSubset)
      if (!providerSet.mcps.includes(m))
        throw new Error(
          "A project can only use MCP servers that are part of the synced provider set.",
        );
  const env = o.env ?? process.env;
  const vars: Record<string, string> = {};
  let mcps: Record<string, Mcp> = Object.create(null);
  if (project.projectMcps.length) {
    if (!project.path)
      throw new Error("Project MCPs need a local checkout of the repository.");
    const s = await sources(project.path, o);
    if (s.url !== url)
      throw new Error("The checkout does not match the project repository.");
    const exported = exportMcps(project.projectMcps, s, env, project.mcpUrls ?? {});
    mcps = exported.mcps;
    for (const names of Object.values(exported.mcpEnv))
      for (const key of names) vars[key] = env[key]!;
  }
  const config: Record<string, unknown> = {
    projects: { "/workspace/repository": { trust_level: "trusted" } },
  };
  if (Object.keys(mcps).length) config.mcp_servers = mcps;
  const files = {
    "config.toml": stringify(config as Parameters<typeof stringify>[0]),
  };
  const bootstrap = {
    repository: { url, revision: project.revision },
    trustRepository: true,
    // MCPs defined only in the project's own config.toml; the gateway allows them besides `mcps`.
    projectMcps: Object.keys(mcps),
    ...(project.providerSubset ? { providers: project.providerSubset } : {}),
    ...(project.mcpSubset ? { mcps: project.mcpSubset } : {}),
  };
  const owner = ownerOf(serverId, c);
  const id = projectId(url);
  const name = `pw-profile-${owner}-${digest({ files, vars, bootstrap })}`;
  if (write)
    await applyTriple(
      run,
      owner,
      c.namespace,
      name,
      { "workspaces.paseo.sh/kind": "project", "workspaces.paseo.sh/project": id },
      files,
      vars,
      { "bootstrap.json": JSON.stringify(bootstrap) },
    );
  return { name, owner, id };
}
