import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsSchema, migrateV1, scopeOf } from "../shared/settings.js";
import { projectId } from "./credentials.js";
import { reconcile } from "./migration.js";
import {
  syncAllProviders,
  syncOneProject,
  refreshCatalog,
  type SyncDeps,
} from "./sync.js";
import {
  addProject,
  approveProject,
  providersStatus,
  projectsStatus,
  removeProject,
  updateProject,
} from "./projects.js";
import type { Kubectl } from "./kubernetes.js";

const repoA = "https://github.com/example/a.git";
const repoB = "https://github.com/example/b.git";

async function fixture(env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "paseo-sync-test-"));
  const home = join(root, "codex");
  await mkdir(home);
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "PRIVATE_CODEX", refresh_token: "PRIVATE_REFRESH" } }),
  );
  return {
    home,
    env: { ANTHROPIC_API_KEY: "PRIVATE_ANTHROPIC", OPENAI_API_KEY: "PRIVATE_OPENAI", ...env },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
// A stateful fake cluster: stores applied objects, reports a ready operator and a current CRD.
function cluster(workspaces: unknown[] = []) {
  const store = new Map<string, any>();
  const writes: any[] = [];
  let failCatalog = false;
  const run: Kubectl = async (args, input) => {
    if (input) {
      const o = input as any;
      if (args[0] === "create") return "";
      if (o.metadata.name === "paseo-workspaces-gateway" && failCatalog) throw new Error("catalog down");
      writes.push(o);
      store.set(`${o.kind.toLowerCase()}/${o.metadata.name}`, o);
      return "";
    }
    if (args[0] === "get" && args[1] === "deployment")
      return JSON.stringify({ status: { availableReplicas: 1, observedGeneration: 1 }, metadata: { generation: 1 } });
    if (args[0] === "get" && args[1].startsWith("paseoworkspaces")) {
      return args.includes("name") || args.includes("-o") && args[args.length - 1] === "name"
        ? ""
        : JSON.stringify({ items: workspaces });
    }
    if (args[0] === "get" && args[1] === "configmap") {
      const o = store.get(`configmap/${args[2]}`);
      const jp = args[args.length - 1];
      if (jp.includes("providers\\.json")) return o?.data["providers.json"] ?? "";
      if (jp.includes("projects\\.json")) return o?.data["projects.json"] ?? "";
      if (jp.includes("labels.workspaces\\.paseo\\.sh/project")) return o?.metadata.labels["workspaces.paseo.sh/project"] ?? "";
    }
    return "";
  };
  const catalog = () => {
    const o = store.get("configmap/paseo-workspaces-gateway");
    return o ? (JSON.parse(o.data["projects.json"]) as any[]) : null;
  };
  return { run, writes, store, catalog, failCatalog: () => (failCatalog = true) };
}
const base = { context: "t", namespace: "ns", image: "img" };
const deps = (f: any, k: ReturnType<typeof cluster>): SyncDeps => ({
  serverId: "srv",
  options: f,
  run: k.run,
  providerContext: async () => ({ snapshot: { entries: [] } as never, controls: {} }),
});
const conf = (extra: Record<string, unknown> = {}) =>
  settingsSchema.parse({
    ...base,
    providers: { selected: ["anthropic-key", "codex-login"] },
    projects: [
      { repository: repoA, trusted: true },
      { repository: repoB, trusted: false },
    ],
    ...extra,
  });

test("settings v1 -> v2, then the split reports the names the client must save", async () => {
  const f = await fixture();
  try {
    const v1 = {
      ...base,
      bundle: { name: "pw-profile-o-legacy", scope: "x", syncedAt: "t", providers: ["anthropic-key"], mcps: [], repository: repoA, gatewayReady: true },
    };
    const v2 = settingsSchema.parse(migrateV1(v1));
    assert.deepEqual(v2.providers.selected, ["anthropic-key"]);
    assert.equal(v2.providers.codexMode, "access-only");
    assert.equal(v2.projects.length, 1);
    assert.equal(v2.projects[0].trusted, true);
    assert.equal(v2.projects[0].providerSubset, null);
    const k = cluster();
    v2.bundle = { ...v2.bundle!, scope: scopeOf(v2) };
    const r = await reconcile(v2, { operator: "ready", crdCurrent: true }, deps(f, k));
    assert.equal(r.migrated, true);
    assert.equal(r.split?.projects[0].repository, repoA);
    assert.match(k.catalog()![0].providers, /^pw-providers-/);
  } finally { await f.cleanup(); }
});

test("providers.sync: set, thin profiles, catalog last; unapproved projects are skipped", async () => {
  const f = await fixture();
  try {
    const k = cluster();
    const out = await syncAllProviders(conf(), deps(f, k));
    assert.equal(out.lastSync.version, out.providerSet.name);
    assert.deepEqual(out.providerSet.providers.sort(), ["anthropic-key", "codex-login"]);
    const [a, b] = out.projects;
    assert.equal(a.id, projectId(repoA));
    assert.equal(a.synced?.providerSet, out.providerSet.name);
    assert.equal(b.skipped, "unapproved");
    assert.equal(b.synced, null);
    assert.equal(k.writes.at(-1).metadata.name, "paseo-workspaces-gateway");
    const cat = k.catalog()!;
    assert.equal(cat.length, 1);
    assert.equal(cat[0].profile, a.synced?.profile);
    assert.equal(cat[0].providers, out.providerSet.name);
  } finally { await f.cleanup(); }
});

test("trust gating: projects.sync refuses an unapproved project and writes nothing", async () => {
  const f = await fixture();
  try {
    const k = cluster();
    const c = conf({ providers: { selected: ["anthropic-key"], lastSync: { at: "t", version: "pw-providers-x-1" } } });
    await assert.rejects(syncOneProject(c, projectId(repoB), deps(f, k)), /Approve/);
    assert.equal(k.writes.length, 0);
    // approve, then the project syncs against the synced set
    const set = await syncAllProviders(c, deps(f, k));
    const approved = (await approveProject(c, { id: projectId(repoB), approved: true })).projects;
    // The client saved the first sync's names for project A.
    const saved = approved.map((p) => (p.repository === repoA ? { ...p, synced: set.projects[0].synced } : p));
    const c2 = conf({ providers: { selected: ["anthropic-key", "codex-login"], lastSync: set.lastSync }, projects: saved });
    const one = await syncOneProject(c2, projectId(repoB), deps(f, k));
    assert.ok(one.project.synced);
    assert.equal(k.catalog()!.length, 2);
    // revoking drops the entry from the catalog
    const revoked = (await approveProject(c2, { id: projectId(repoB), approved: false })).projects;
    await refreshCatalog(conf({ projects: revoked }), deps(f, k));
    assert.equal(k.catalog()!.length, 1);
  } finally { await f.cleanup(); }
});

test("subset narrowing: edits must stay inside the selection; a sync that drops a provider keeps the old pair", async () => {
  const f = await fixture();
  try {
    const k = cluster();
    let c = conf();
    const first = await syncAllProviders(c, deps(f, k));
    // narrowing inside the selection is accepted, widening is rejected
    c = conf({ providers: { selected: ["anthropic-key", "codex-login"], lastSync: first.lastSync } });
    const narrowed = await updateProject(c, { id: projectId(repoA), providerSubset: ["codex-login"] });
    assert.deepEqual(narrowed.project.providerSubset, ["codex-login"]);
    await assert.rejects(updateProject(c, { id: projectId(repoA), providerSubset: ["gemini-key"] }), /selected/);
    // Save the subset and sync: the profile lists only the subset and the catalog is repointed.
    c = conf({
      providers: { selected: ["anthropic-key", "codex-login"], lastSync: first.lastSync },
      projects: [{ ...narrowed.project, synced: first.projects[0].synced }, { repository: repoB }],
    });
    const second = await syncAllProviders(c, deps(f, k));
    const profile = k.store.get(`configmap/${second.projects[0].synced!.profile}`);
    assert.deepEqual(JSON.parse(profile.data["bootstrap.json"]).providers, ["codex-login"]);
    // Now the user deselects codex: the subset no longer fits, the project keeps its old pair.
    const oldPair = second.projects[0].synced!;
    c = conf({
      providers: { selected: ["anthropic-key"], lastSync: second.lastSync },
      projects: [
        { ...narrowed.project, synced: oldPair },
        { repository: repoB, trusted: true },
      ],
    });
    const third = await syncAllProviders(c, deps(f, k));
    const [a, b] = third.projects;
    assert.match(a.error ?? "", /provider set/);
    assert.equal(a.synced, null);
    assert.ok(b.synced);
    const cat = k.catalog()!;
    assert.equal(cat.find((e) => e.profile === oldPair.profile).providers, oldPair.providerSet);
    assert.equal(cat.length, 2);
  } finally { await f.cleanup(); }
});

test("partial failure keeps the old state: failed set and failed catalog change nothing", async () => {
  const f = await fixture();
  try {
    const k = cluster();
    const c = conf();
    const first = await syncAllProviders(c, deps(f, k));
    const before = JSON.stringify(k.catalog());
    const writesBefore = k.writes.length;
    // A selected key vanished from the daemon: nothing is written, the catalog is untouched.
    const broken = await fixture();
    try {
      await assert.rejects(
        syncAllProviders(conf({ providers: { selected: ["gemini-key"], lastSync: first.lastSync } }), deps({ ...broken, env: {} }, k)),
        /GEMINI_API_KEY/,
      );
    } finally { await broken.cleanup(); }
    assert.equal(k.writes.length, writesBefore);
    assert.equal(JSON.stringify(k.catalog()), before);
    // The catalog write itself fails: reported, previous catalog stays.
    k.failCatalog();
    const out = await syncAllProviders(
      conf({ providers: { selected: ["anthropic-key"], lastSync: first.lastSync } }),
      deps(f, k),
    );
    assert.equal(out.catalog.written, false);
    assert.match(out.catalog.error ?? "", /catalog down/);
    assert.equal(JSON.stringify(k.catalog()), before);
    // An old CRD refuses to sync at all.
    const old: Kubectl = async (args, input) => {
      if (args[0] === "create") throw new Error("unknown field");
      return k.run(args, input);
    };
    await assert.rejects(syncAllProviders(c, { ...deps(f, k), run: old }), /out of date/);
  } finally { await f.cleanup(); }
});

test("project mutations: unique URL, canonical id, approval, overrides, remove keeps workspaces", async () => {
  const c = conf();
  await assert.rejects(addProject(c, { repository: repoA }), /already/);
  await assert.rejects(addProject(c, { repository: "https://user:pw@github.com/x/y.git" }), /credential-free/);
  await assert.rejects(addProject(c, {}), /repository URL/);
  const added = await addProject(c, { repository: "https://github.com/example/c.git", revision: "main" });
  assert.equal(added.project.id, projectId("https://github.com/example/c.git"));
  assert.equal(added.project.trusted, false);
  assert.equal(added.projects.length, 3);
  const c2 = conf({ projects: added.projects });
  const up = await updateProject(c2, { id: added.project.id, overrides: { docker: true, image: "x:1" } });
  assert.deepEqual(up.project.overrides, { docker: true, image: "x:1" });
  const cleared = await updateProject(conf({ projects: up.projects }), { id: added.project.id, overrides: { image: null } });
  assert.deepEqual(cleared.project.overrides, { docker: true });
  await assert.rejects(updateProject(c2, { id: added.project.id, projectMcps: ["m"] }), /checkout/);
  await assert.rejects(updateProject(c2, { id: added.project.id, revision: "--bad rev" }), /branch/);
  const k = cluster([{ spec: { bootstrap: { configMapName: "pw-profile-o-1" } } }]);
  const c3 = conf({
    projects: [{ repository: repoA, trusted: true, synced: { profile: "pw-profile-o-1", providerSet: "s", at: "t" } }],
  });
  const removed = await removeProject(c3, projectId(repoA), k.run);
  assert.equal(removed.projects.length, 0);
  assert.equal(removed.workspaces, 1);
  assert.equal(k.writes.length, 0);
});

test("status: found/selected/synced badges and out-of-date detection", async () => {
  const f = await fixture();
  try {
    const k = cluster();
    const c = conf();
    const before = await providersStatus(c, k.run, f);
    const row = (s: any, id: string) => s.providers.find((p: any) => p.id === id);
    assert.equal(row(before, "anthropic-key").found, true);
    assert.equal(row(before, "anthropic-key").state, "not-synced");
    assert.equal(row(before, "gemini-key").state, "none");
    assert.equal(row(before, "gemini-key").found, false);
    const out = await syncAllProviders(c, deps(f, k));
    const synced = conf({
      providers: { selected: ["anthropic-key", "codex-login"], lastSync: out.lastSync },
      projects: [{ repository: repoA, trusted: true, synced: out.projects[0].synced }, { repository: repoB }],
    });
    const after = await providersStatus(synced, k.run, f);
    assert.equal(row(after, "anthropic-key").state, "synced");
    // Deselecting a synced provider is out of date until the next sync.
    const dropped = conf({ providers: { selected: ["anthropic-key"], lastSync: out.lastSync } });
    assert.equal(row(await providersStatus(dropped, k.run, f), "codex-login").state, "out-of-date");
    const list = await projectsStatus(synced, "srv", k.run, f);
    assert.deepEqual(list.projects.map((p) => p.state), ["synced", "unapproved"]);
    assert.deepEqual(list.projects[0].providers, { used: 2, total: 2 });
    assert.equal(list.projects[0].workspaces, 0);
    // A settings change (revision) makes the saved profile out of date.
    const edited = conf({
      providers: synced.providers,
      projects: [{ repository: repoA, trusted: true, revision: "dev", synced: out.projects[0].synced }],
    });
    assert.equal((await projectsStatus(edited, "srv", k.run, f)).projects[0].state, "out-of-date");
    // A newer provider set makes every project out of date.
    const newer = conf({ providers: { ...synced.providers, lastSync: { at: "t", version: "pw-providers-z" } }, projects: synced.projects });
    assert.equal((await projectsStatus(newer, "srv", k.run, f)).projects[0].state, "out-of-date");
  } finally { await f.cleanup(); }
});
