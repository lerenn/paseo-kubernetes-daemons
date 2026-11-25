import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultPods,
  mergePods,
  parseQuantity,
  podsThatFit,
  podWarnings,
  estimate,
  validatePods,
  catalogPods,
} from "../shared/pods.js";
import { settingsSchema } from "../shared/settings.js";
import { buildCatalog } from "./catalog.js";
import { updateProject } from "./projects.js";
import { projectId } from "./credentials.js";
import { podsCheck, podsStatus } from "./pods.js";
import type { Kubectl } from "./kubernetes.js";

test("defaults equal the gateway's historical values and are valid", () => {
  const p = defaultPods();
  assert.deepEqual(validatePods(p), []);
  const c = catalogPods(p, true, true);
  assert.deepEqual(c.resources, {
    requests: { cpu: "250m", memory: "512Mi", "ephemeral-storage": "1Gi" },
    limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
  });
  assert.equal(c.storage, undefined);
  assert.equal(c.dockerDataSize, "10Gi");
  assert.equal(c.dockerResources?.limits["ephemeral-storage"], "12Gi");
});
test("quantities parse; garbage does not", () => {
  assert.equal(parseQuantity("250m"), 0.25);
  assert.equal(parseQuantity("2"), 2);
  assert.equal(parseQuantity("1Gi"), 1024 ** 3);
  assert.equal(parseQuantity("1G"), 1e9);
  for (const bad of ["", "lots", "1 Gi", "-1", "1gi", "Gi"]) assert.equal(parseQuantity(bad), null, bad);
});
test("validation: request <= limit, positive, size >= 1Gi, class name", () => {
  const p = defaultPods();
  p.compute.cpuRequest = "4";
  p.compute.memoryLimit = "lots";
  p.storage.size = "500Mi";
  p.storage.storageClassName = "Bad Name";
  p.docker.scratchLimit = "0";
  const paths = validatePods(p).map((i) => i.path);
  for (const want of ["compute.cpuRequest", "compute.memoryLimit", "storage.size", "storage.storageClassName", "docker.scratchLimit"])
    assert.ok(paths.includes(want), want);
  const eq = defaultPods();
  eq.compute.cpuRequest = "2";
  assert.deepEqual(validatePods(eq), []);
});
test("override merges per field over the global defaults", () => {
  const m = mergePods(defaultPods(), { compute: { cpuLimit: "8" }, storage: { size: "20Gi" } });
  assert.equal(m.compute.cpuLimit, "8");
  assert.equal(m.compute.cpuRequest, "250m");
  assert.equal(m.storage.size, "20Gi");
  assert.equal(m.docker.dataSize, "10Gi");
});
test("catalog: pod fields follow docker/ephemeral and an invalid project throws", () => {
  const c = settingsSchema.parse({
    docker: false,
    projects: [
      { repository: "https://example.com/a.git", trusted: true, synced: { profile: "p", providerSet: "s", at: "t" }, overrides: { docker: true, ephemeral: false, pods: { storage: { storageClassName: "fast" } } } },
      { repository: "https://example.com/b.git", trusted: true, synced: { profile: "q", providerSet: "s", at: "t" } },
    ],
  });
  const [a, b] = buildCatalog(c, { crdCurrent: true });
  assert.equal(a.storageClassName, "fast");
  assert.ok(a.dockerResources);
  assert.equal(b.dockerResources, undefined);
  assert.equal(b.storageClassName, undefined);
  c.projects[1].overrides = { pods: { compute: { cpuRequest: "9", cpuLimit: "1" } } };
  assert.throws(() => buildCatalog(c, { crdCurrent: true }), /Invalid pod settings/);
});
test("projects.update validates the merged pod overrides and null clears them", async () => {
  const url = "https://example.com/a.git";
  const c = settingsSchema.parse({ projects: [{ repository: url, trusted: true }] });
  const id = projectId(url);
  await assert.rejects(
    updateProject(c, { id, overrides: { pods: { compute: { cpuRequest: "9", cpuLimit: "1" } } } }),
    /Invalid pod settings/,
  );
  const ok = await updateProject(c, { id, overrides: { pods: { compute: { cpuLimit: "4" } } } });
  assert.equal(ok.project.overrides.pods?.compute?.cpuLimit, "4");
  const cleared = await updateProject(settingsSchema.parse({ projects: ok.projects }), { id, overrides: { pods: null } });
  assert.equal(cleared.project.overrides.pods, undefined);
});
test("warnings: quota, expansion and missing class; fit counts pods", () => {
  const p = defaultPods();
  const e = estimate(p, false, true);
  const quotas = [{ name: "q", hard: { "requests.cpu": "1", "limits.memory": "32Gi", pods: "8" } }];
  assert.equal(podsThatFit(e, quotas), 4);
  assert.deepEqual(podWarnings(p, false, true, quotas, null), []);
  p.compute.cpuRequest = "2";
  assert.match(podWarnings(p, false, true, quotas, null).join(" "), /requests\.cpu/);
  p.compute.cpuRequest = "250m";
  p.storage.storageClassName = "gone";
  const classes = [{ name: "std", isDefault: true, allowVolumeExpansion: false, provisioner: "x" }];
  assert.match(podWarnings(p, false, false, null, classes).join(" "), /does not exist/);
  p.storage.storageClassName = "";
  assert.match(podWarnings(p, false, false, null, classes).join(" "), /expansion/);
  assert.deepEqual(podWarnings(p, false, true, null, classes), []);
});
test("cluster reads degrade silently when forbidden", async () => {
  const forbidden: Kubectl = async () => {
    throw new Error("forbidden");
  };
  const c = settingsSchema.parse({});
  const s = await podsStatus(c, forbidden);
  assert.equal(s.quotas, null);
  assert.equal(s.storageClasses, null);
  assert.deepEqual(s.issues, []);
  const r = await podsCheck({ pods: c.pods }, c, forbidden);
  assert.equal(r.fit, null);
  assert.deepEqual(r.errors, []);
  const ok: Kubectl = async (args) =>
    args.includes("resourcequotas")
      ? JSON.stringify({ items: [{ metadata: { name: "q" }, spec: { hard: { pods: "3" } } }] })
      : JSON.stringify({ items: [{ metadata: { name: "std", annotations: { "storageclass.kubernetes.io/is-default-class": "true" } }, provisioner: "p", allowVolumeExpansion: true }] });
  const full = await podsStatus(c, ok);
  assert.equal(full.quotas?.[0].hard.pods, "3");
  assert.equal(full.storageClasses?.[0].isDefault, true);
  assert.equal((await podsCheck({ pods: c.pods }, c, ok)).fit, 3);
});
