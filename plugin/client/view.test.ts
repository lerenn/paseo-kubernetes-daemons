import test from "node:test";
import assert from "node:assert/strict";
import { applySynced, projectName, projectStateBadge, removeCopy, rowStateBadge, cleanOverride, capacityText, formatBytes, formatCores, issueFor, pendingReason } from "./view.js";
import { projectSchema } from "../shared/settings.js";

const p = (repository: string) => projectSchema.parse({ repository });
test("applySynced updates only matching repositories with a result", () => {
  const synced = { profile: "x", providerSet: "y", at: "t" };
  const out = applySynced(
    [p("https://github.com/a/b"), p("https://github.com/a/c")],
    [
      { repository: "https://github.com/a/b", synced },
      { repository: "https://github.com/a/c", synced: null },
    ],
  );
  assert.deepEqual(out[0].synced, synced);
  assert.equal(out[1].synced, null);
});
test("badges and names", () => {
  assert.equal(projectName("https://github.com/a/repo.git"), "repo");
  assert.equal(projectName("git@github.com:a/repo"), "repo");
  assert.equal(projectStateBadge("unapproved").tone, "warning");
  assert.equal(rowStateBadge("none"), null);
});
test("remove copy states running workspaces stay", () => {
  assert.match(removeCopy("repo", 2), /2 running workspaces stay untouched/);
  assert.match(removeCopy("repo", 1), /1 running workspace stays untouched/);
});
test("cleanOverride drops blank fields and empty groups", () => {
  assert.equal(cleanOverride({ compute: { cpuLimit: " " }, storage: {} }), undefined);
  assert.deepEqual(cleanOverride({ compute: { cpuLimit: "4", cpuRequest: "" } }), { compute: { cpuLimit: "4" } });
  assert.equal(cleanOverride(undefined), undefined);
});
test("formatters and capacity text", () => {
  assert.equal(formatCores(0.25), "250m CPU");
  assert.equal(formatCores(2), "2 CPU");
  assert.equal(formatBytes(512 * 1024 ** 2), "512Mi");
  assert.equal(formatBytes(4 * 1024 ** 3), "4Gi");
  const per = { requests: { cpu: 0.5, memory: 768 * 1024 ** 2 }, storage: 10 * 1024 ** 3 };
  assert.match(capacityText(per, 4), /500m CPU and 768Mi memory, plus a 10Gi volume.*about 4 workspaces/);
  assert.doesNotMatch(capacityText(per, null), /quota/);
});
test("issueFor and pendingReason", () => {
  assert.equal(issueFor([{ path: "a.b", message: "bad" }], "a.b"), "bad");
  assert.equal(issueFor([], "a.b"), undefined);
  assert.equal(pendingReason("Pending", "Insufficient cpu"), "Insufficient cpu");
  assert.equal(pendingReason("Ready", "x"), null);
  assert.equal(pendingReason("Pending", ""), null);
});
