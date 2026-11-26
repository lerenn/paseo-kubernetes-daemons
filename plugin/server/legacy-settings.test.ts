import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { carryOverLegacySettings } from "./legacy-settings.js";

async function home(oldDoc?: unknown, newDoc?: unknown) {
  const h = await mkdtemp(path.join(tmpdir(), "legacy-"));
  for (const [id, doc] of [["kubernetes-workspaces", oldDoc], ["kubernetes-daemons", newDoc]] as const) {
    if (doc === undefined) continue;
    await mkdir(path.join(h, "plugin-settings", id), { recursive: true });
    await writeFile(path.join(h, "plugin-settings", id, "workspace-setup.json"), JSON.stringify(doc));
  }
  return h;
}
const target = (h: string) => path.join(h, "plugin-settings", "kubernetes-daemons", "workspace-setup.json");

test("copies the old document once and renames old resource names", async () => {
  const h = await home({
    version: 2,
    values: { namespace: "paseo-workspaces", image: "ghcr.io/lerenn/paseo-workspace:0.4.1", context: "c", projects: [{ repository: "a/b" }], synced: { digest: "x" } },
  });
  assert.equal(await carryOverLegacySettings(h), "copied");
  const out = JSON.parse(await readFile(target(h), "utf8"));
  assert.equal(out.version, 2);
  assert.deepEqual(out.values, { namespace: "paseo-daemons", image: "", context: "c", projects: [{ repository: "a/b" }], synced: null });
  assert.equal(await carryOverLegacySettings(h), "none");
});

test("never overwrites an existing document and ignores a missing one", async () => {
  const h = await home({ version: 2, values: { context: "old" } }, { version: 2, values: { context: "new" } });
  assert.equal(await carryOverLegacySettings(h), "none");
  assert.equal(JSON.parse(await readFile(target(h), "utf8")).values.context, "new");
  assert.equal(await carryOverLegacySettings(await home()), "none");
});
