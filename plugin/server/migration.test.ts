import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncProject, syncProviders, type ProviderSelection } from "./credentials.js";
import { reconcile } from "./migration.js";
import { settingsSchema, scopeOf } from "../shared/settings.js";
import type { Kubectl } from "./kubernetes.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-mig-test-"));
  const home = join(root, "codex");
  await mkdir(home);
  await writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "PRIVATE_CODEX", refresh_token: "PRIVATE_REFRESH" } }));
  await writeFile(join(home, "config.toml"), `[mcp_servers.docs]\nurl="https://docs.example/mcp"\nbearer_token_env_var="DOCS_TOKEN"\n`);
  return { home, env: { DOCS_TOKEN: "PRIVATE_DOCS", ANTHROPIC_API_KEY: "PRIVATE_ANTHROPIC" }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
// Records every applied object and every catalog read; the catalog is reported absent.
function recorder() {
  const writes: Record<string, any>[] = [];
  const run: Kubectl = async (args, input) => {
    if (input) writes.push(input as Record<string, any>);
    return "";
  };
  return { writes, run };
}
const selection: ProviderSelection = {
  providers: ["codex-login", "anthropic-key"], mcps: ["docs"], mcpUrls: {},
  includeMcpOAuthFile: false, codexMode: "access-only",
};
const repo = "https://github.com/example/repo.git";
const conf = () => settingsSchema.parse({ context: "t", namespace: "ns", image: "img" });

test("provider set: three immutable objects, kind label, blanked refresh token, secret-free ConfigMap", async () => {
  const f = await fixture();
  try {
    const { writes, run } = recorder();
    const c = conf();
    const set = await syncProviders(c, selection, "srv", run, f, undefined, {});
    assert.equal(writes.length, 3);
    assert.ok(writes.every((o) => o.immutable === true));
    assert.ok(writes.every((o) => o.metadata.labels["workspaces.paseo.sh/kind"] === "providers" && o.metadata.labels["workspaces.paseo.sh/profile-owner"] === set.owner));
    assert.deepEqual(writes.map((o) => o.metadata.name), [set.name, set.name + "-env", set.name]);
    assert.match(set.name, /^pw-providers-[0-9a-f]{16}-[0-9a-f]{20}$/);
    assert.ok(set.name.length + 4 <= 63);
    const files = JSON.parse(Buffer.from(writes[0].data["files.json"], "base64").toString());
    assert.equal(JSON.parse(files["auth.json"]).tokens.refresh_token, "");
    assert.match(files["auth.json"], /PRIVATE_CODEX/);
    assert.ok(files["config.toml"].includes("docs"));
    assert.deepEqual(Object.keys(writes[1].data).sort(), ["ANTHROPIC_API_KEY", "DOCS_TOKEN"]);
    assert.ok(!JSON.stringify(writes[2]).includes("PRIVATE_"));
    const meta = JSON.parse(writes[2].data["providers.json"]);
    assert.deepEqual(meta.providers, selection.providers);
    assert.deepEqual(meta.mcps, ["docs"]);
    assert.deepEqual(meta.mcpEnv, { docs: ["DOCS_TOKEN"] });
    assert.deepEqual(meta.providerControls, {});
    const refreshing = await syncProviders(c, { ...selection, codexMode: "refreshing" }, "srv", run, f);
    assert.notEqual(refreshing.name, set.name);
  } finally { await f.cleanup(); }
});
test("project profile: project labels, thin config, subset validated against the set", async () => {
  const f = await fixture();
  try {
    const { writes, run } = recorder();
    const c = conf();
    const set = { providers: ["codex-login"], mcps: ["docs"] };
    const base = { repository: repo, trusted: true, revision: "main", projectMcps: [] };
    const r = await syncProject(c, { ...base, providerSubset: ["codex-login"] }, set, "srv", run, f);
    assert.equal(writes.length, 3);
    assert.match(r.name, /^pw-profile-[0-9a-f]{16}-[0-9a-f]{20}$/);
    const labels = writes[0].metadata.labels;
    assert.equal(labels["workspaces.paseo.sh/kind"], "project");
    assert.equal(labels["workspaces.paseo.sh/project"], r.id);
    const b = JSON.parse(writes[2].data["bootstrap.json"]);
    assert.deepEqual(b, { repository: { url: repo, revision: "main" }, trustRepository: true, projectMcps: [], providers: ["codex-login"] });
    const files = JSON.parse(Buffer.from(writes[0].data["files.json"], "base64").toString());
    assert.match(files["config.toml"], /trust_level = "trusted"/);
    assert.ok(!files["config.toml"].includes("mcp_servers"));
    // null subset omits `providers` (= all)
    await syncProject(c, { ...base, providerSubset: null }, set, "srv", run, f);
    assert.ok(!("providers" in JSON.parse(writes[5].data["bootstrap.json"])));
    await assert.rejects(syncProject(c, { ...base, providerSubset: ["anthropic-key"] }, set, "srv", run, f), /provider set/);
    await assert.rejects(syncProject(c, { ...base, trusted: false, providerSubset: null }, set, "srv", run, f), /Approve/);
  } finally { await f.cleanup(); }
});
function legacyConfig() {
  const c = settingsSchema.parse({ context: "t", namespace: "ns", image: "img" });
  c.bundle = { name: "pw-profile-o-legacy", scope: scopeOf(c), syncedAt: "t", providers: ["anthropic-key"], mcps: [], repository: repo, gatewayReady: true };
  return c;
}
const deps = (f: any, writes: any[], existing = "") => ({
  serverId: "srv",
  options: f,
  run: (async (args, input) => {
    if (input) writes.push(input);
    if (args[0] === "get" && args[2] === "paseo-workspaces-gateway" && args.includes("jsonpath={.data.projects\\.json}")) return existing;
    return "";
  }) as Kubectl,
  providerContext: async () => ({ snapshot: { entries: [] } as never, controls: {} }),
});
test("migration splits the legacy profile into set + project and writes the catalog last", async () => {
  const f = await fixture();
  try {
    const writes: any[] = [];
    const r = await reconcile(legacyConfig(), { operator: "ready", crdCurrent: true }, deps(f, writes));
    assert.deepEqual(r, { migrated: true });
    assert.equal(writes.length, 7);
    const last = writes[6];
    assert.equal(last.metadata.name, "paseo-workspaces-gateway");
    for (const w of writes.slice(0, 6)) assert.notEqual(w.metadata.name, "paseo-workspaces-gateway");
    const [entry] = JSON.parse(last.data["projects.json"]);
    assert.match(entry.providers, /^pw-providers-/);
    assert.match(entry.profile, /^pw-profile-/);
    assert.notEqual(entry.profile, "pw-profile-o-legacy");
    // Idempotent: a catalog that already has a providers entry is left alone.
    const again: any[] = [];
    const r2 = await reconcile(legacyConfig(), { operator: "ready", crdCurrent: true }, deps(f, again, JSON.stringify([entry])));
    assert.deepEqual(r2, { migrated: false });
    assert.equal(again.length, 0);
  } finally { await f.cleanup(); }
});
test("old CRD: only the legacy entry is written, never a providers field", async () => {
  const f = await fixture();
  try {
    const writes: any[] = [];
    const r = await reconcile(legacyConfig(), { operator: "ready", crdCurrent: false }, deps(f, writes));
    assert.equal(r.migrated, false);
    assert.equal(writes.length, 1);
    assert.deepEqual(JSON.parse(writes[0].data["projects.json"]).map((e: any) => e.profile), ["pw-profile-o-legacy"]);
    assert.ok(!writes[0].data["projects.json"].includes('"providers"'));
  } finally { await f.cleanup(); }
});
test("failed split keeps the legacy catalog entry and reports the error", async () => {
  const f = await fixture();
  try {
    const writes: any[] = [];
    const d = deps({ ...f, env: {} }, writes); // missing ANTHROPIC_API_KEY on the daemon
    const r = await reconcile(legacyConfig(), { operator: "ready", crdCurrent: true }, d);
    assert.match(r.error ?? "", /ANTHROPIC_API_KEY/);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].data["projects.json"])[0].profile, "pw-profile-o-legacy");
    const none = await reconcile(legacyConfig(), { operator: "missing", crdCurrent: false }, deps(f, []));
    assert.deepEqual(none, { migrated: false });
  } finally { await f.cleanup(); }
});
