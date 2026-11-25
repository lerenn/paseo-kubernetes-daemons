import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeOf, settingsSchema } from "../shared/settings.js";
import { pluginDigest, pluginEntries, pluginState } from "../shared/plugins.js";
import { buildCatalog } from "./catalog.js";
import { addPlugin, pluginsStatus, removePlugin, syncPlugins, updatePlugin } from "./plugins.js";
import { crdCurrent, type Kubectl } from "./kubernetes.js";
import type { SyncDeps } from "./sync.js";

const SECRET = "PRIVATE_PLUGIN_TOKEN";
const repo = "https://github.com/example/a.git";
const conf = (extra: Record<string, unknown> = {}) =>
  settingsSchema.parse({
    context: "t",
    namespace: "ns",
    image: "img",
    projects: [{ repository: repo, trusted: true, synced: { profile: "pw-profile-o-p", providerSet: "pw-providers-o-s", at: "t" } }],
    ...extra,
  });
function cluster(failSecret = false) {
  const writes: any[] = [];
  const store = new Map<string, any>();
  const run: Kubectl = async (args, input) => {
    if (input) {
      const o = input as any;
      if (o.kind === "Secret" && failSecret) throw new Error("boom " + JSON.stringify(o.data));
      writes.push(o);
      store.set(o.kind + "/" + o.metadata.name, o);
      return "";
    }
    if (args[0] === "get" && args[1] === "deployment")
      return JSON.stringify({ status: { availableReplicas: 1, observedGeneration: 1 }, metadata: { generation: 1 } });
    return "";
  };
  return { run, writes, store };
}
const deps = (k: ReturnType<typeof cluster>): SyncDeps => ({
  serverId: "srv",
  run: k.run,
  providerContext: async () => ({ snapshot: { entries: [] } as never, controls: {} }),
});

test("settings: plugin entries are validated and unique", () => {
  assert.equal(conf().plugins.length, 0);
  assert.throws(() => conf({ plugins: [{ source: "--evil" }] }));
  assert.throws(() => conf({ plugins: [{ source: "a/b", ref: "x y" }] }));
  assert.throws(() => conf({ plugins: [{ source: "a/b", env: { "BAD-NAME": "x" } }] }));
  assert.throws(() => conf({ plugins: [{ source: "a/b" }, { source: "a/b" }] }));
  assert.equal(conf({ plugins: [{ source: "git:o/r", ref: "v1" }] }).plugins[0].enabled, true);
});

test("add, update and remove return the next list", () => {
  let c = conf();
  const added = addPlugin(c, { source: "git:o/r", ref: "v1", env: { TOKEN: SECRET } });
  c = conf({ plugins: added.plugins });
  assert.throws(() => addPlugin(c, { source: "git:o/r", ref: "v1" }), /already added/);
  const upd = updatePlugin(c, { source: "git:o/r", ref: "v1", enabled: false });
  assert.equal(upd.plugin.enabled, false);
  assert.equal(removePlugin(c, { source: "git:o/r", ref: "v1" }).plugins.length, 0);
  assert.throws(() => removePlugin(c, { source: "x", ref: "" }), /Unknown/);
  const status = JSON.stringify(pluginsStatus(c));
  assert.ok(!status.includes(SECRET));
  assert.deepEqual(pluginsStatus(c).plugins[0].envKeys, ["TOKEN"]);
});

test("plugins.sync writes a labelled Secret per plugin with variables, catalog last, no values leaked", async () => {
  const k = cluster();
  const c = conf({ plugins: [{ source: "git:o/r", ref: "v1", env: { TOKEN: SECRET } }, { source: "o/plain", ref: "v2" }, { source: "o/off", enabled: false }] });
  const out = await syncPlugins(c, deps(k));
  assert.ok(!JSON.stringify(out).includes(SECRET));
  const [a, b, d] = out.plugins;
  assert.match(a.synced!.secret!, /^pw-plugin-[0-9a-f]{16}-[0-9a-f]{20}$/);
  assert.equal(b.synced!.secret, undefined);
  assert.equal(d.skipped, "disabled");
  const secret = k.writes.find((w) => w.kind === "Secret");
  assert.equal(secret.immutable, true);
  assert.equal(secret.data.TOKEN, Buffer.from(SECRET).toString("base64"));
  assert.ok(secret.metadata.labels["workspaces.paseo.sh/profile-owner"]);
  assert.equal(k.writes.at(-1).metadata.name, "paseo-workspaces-gateway");
  const catalog = JSON.parse(k.writes.at(-1).data["projects.json"]);
  assert.deepEqual(catalog[0].plugins, [
    { source: "git:o/r", ref: "v1", configSecret: a.synced!.secret },
    { source: "o/plain", ref: "v2" },
  ]);
});

test("a failing Secret write reports a generic error and keeps the previous state", async () => {
  const k = cluster(true);
  const c = conf({ plugins: [{ source: "git:o/r", ref: "v1", env: { TOKEN: SECRET } }] });
  const out = await syncPlugins(c, deps(k));
  assert.equal(out.plugins[0].synced, null);
  assert.ok(!JSON.stringify(out).includes(SECRET));
  assert.ok(!JSON.stringify(out).includes(Buffer.from(SECRET).toString("base64")));
  assert.deepEqual(JSON.parse(k.writes.at(-1).data["projects.json"])[0].plugins, undefined);
});

test("state follows the content digest; catalog omits unsynced, disabled and old-CRD plugins", () => {
  const p = conf({ plugins: [{ source: "o/a", ref: "v1", env: { T: "1" } }] }).plugins[0];
  assert.equal(pluginState(p), "not-synced");
  const synced = { ...p, synced: { digest: pluginDigest(p), at: "t", secret: "pw-plugin-x" } };
  assert.equal(pluginState(synced), "synced");
  assert.equal(pluginState({ ...synced, env: { T: "2" } }), "out-of-date");
  assert.deepEqual(pluginEntries([p]), []);
  assert.deepEqual(pluginEntries([{ ...synced, enabled: false }]), []);
  const c = conf({ plugins: [synced] });
  assert.equal(buildCatalog(c, { crdCurrent: true })[0].plugins?.[0].configSecret, "pw-plugin-x");
  // Legacy (no provider set) entries survive an old CRD, but never carry plugins.
  const legacy = conf({
    projects: [{ repository: repo, trusted: true, synced: null }],
    bundle: { name: "pw-profile-o-legacy", scope: scopeOf(c), syncedAt: "t", providers: [], mcps: [], repository: repo, gatewayReady: true },
    plugins: [synced],
  });
  assert.equal(buildCatalog(legacy, { crdCurrent: false })[0].plugins, undefined);
});

test("the CRD probe includes spec.bootstrap.plugins", async () => {
  let probe: any;
  await crdCurrent(async (_a, input) => ((probe = input), ""));
  assert.equal(probe.spec.bootstrap.plugins[0].configSecretName, "probe");
});
