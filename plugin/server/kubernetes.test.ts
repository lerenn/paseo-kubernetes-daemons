import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyOwned,
  inspect,
  KubernetesError,
  type Kubectl,
} from "./kubernetes.js";
import { settingsSchema } from "../shared/settings.js";
test("operator inspection distinguishes missing CRD, unavailable access and available deployment", async () => {
  const c = settingsSchema.parse({});
  for (const reason of ["missing", "forbidden", "unavailable"] as const) {
    const result = await inspect(c, async () => {
      throw new KubernetesError(reason);
    });
    assert.equal(
      result.operator,
      reason === "missing" ? "missing" : "unavailable",
    );
  }
  const run: Kubectl = async (args) =>
    args[0] === "config"
      ? "cluster"
      : args[1] === "deployment"
        ? JSON.stringify({
            metadata: { generation: 2 },
            status: { observedGeneration: 2, availableReplicas: 1 },
          })
        : "";
  assert.equal((await inspect(c, run)).operator, "ready");
});
test("never overwrites an unmanaged or foreign Secret", async () => {
  const secret = { kind: "Secret", metadata: { name: "test" }, data: {} };
  for (const label of ["other", ""]) {
    let writes = 0;
    const run: Kubectl = async (args, input) => {
      if (input) writes++;
      return args.includes("-o") && args.at(-1) === "name"
        ? "secret/test"
        : label;
    };
    await assert.rejects(applyOwned(run, secret, "owner"));
    assert.equal(writes, 0);
  }
});
