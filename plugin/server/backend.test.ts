import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaseoApi } from "@getpaseo/client";
import { syncHosts, syncGateway, create, release, defaults } from "./backend.js";
import { KubernetesError } from "./kubernetes.js";

test("validates names before invoking kubectl", async () => {
  await assert.rejects(create("../wrong"));
  await assert.rejects(release("--all"));
});
test("registers ready environments, reverse links, and removes only stale owned hosts", async () => {
  const previous = process.env.PASEO_MAIN_CONNECTION;
  process.env.PASEO_MAIN_CONNECTION = "main:6767";
  const removed: string[] = [];
  const adds: unknown[] = [];
  const reverse: unknown[] = [];
  const host = (
    id: string,
    uid: string,
    scope = "default/paseo-workspaces",
  ) => ({
    registrationId: id,
    metadata: {
      manager: "paseo-kubernetes-workspaces",
      scope,
      workspaceUid: uid,
    },
  });
  const api = {
    hosts: {
      list: async () => ({
        hosts: [
          host("stale", "old"),
          host("other-cluster", "x", "other/ns"),
          { registrationId: "manual", metadata: {} },
        ],
      }),
      remove: async (id: string) => {
        removed.push(id);
      },
      add: async (input: unknown) => {
        adds.push(input);
        return { serverId: "remote", status: "online" };
      },
      client: async () => ({
        hosts: {
          add: async (input: unknown) => {
            reverse.push(input);
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  try {
    const results = await syncHosts(api, [
      {
        metadata: { name: "ready", uid: "new" },
        status: { phase: "Ready", endpoint: "pod:6767" },
      },
      {
        metadata: { name: "pending", uid: "pending" },
        status: { phase: "Pending" },
      },
    ]);
    assert.deepEqual(removed, ["stale"]);
    assert.equal(adds.length, 1);
    assert.equal((adds[0] as { label: string }).label, "Kubernetes Pod pw-ready");
    assert.equal(reverse.length, 1);
    assert.equal(results[0].serverId, "remote");
    assert.equal(results[1].serverId, null);
  } finally {
    if (previous === undefined) delete process.env.PASEO_MAIN_CONNECTION;
    else process.env.PASEO_MAIN_CONNECTION = previous;
  }
});

test("syncGateway registers the virtual host while the gateway Secret exists", async () => {
  const adds: any[] = [];
  const removed: string[] = [];
  let present = true;
  const api = {
    hosts: {
      list: async () => ({
        self: { serverId: "main", label: "Main" },
        hosts: present
          ? []
          : [
              {
                registrationId: "gw",
                metadata: { manager: "paseo-kubernetes-workspaces", scope: "c1/ns", gateway: "true" },
              },
              { registrationId: "pod", metadata: { manager: "paseo-kubernetes-workspaces", scope: "c1/ns", workspaceUid: "u" } },
            ],
      }),
      add: async (input: unknown) => {
        adds.push(input);
        return { serverId: "gw", status: "online" };
      },
      remove: async (id: string) => {
        removed.push(id);
      },
    },
  } as unknown as PaseoApi;
  const c = { ...defaults(), namespace: "ns", clusterId: "c1", context: "" };
  const run = async (args: string[]) => {
    if (!present) throw new KubernetesError("missing");
    return args[1] === "secret"
      ? JSON.stringify({ data: { password: Buffer.from("s3 cret").toString("base64") } })
      : "service/paseo-workspaces-gateway";
  };
  await syncGateway(api, c, run);
  assert.equal(adds.length, 1);
  assert.equal(adds[0].label, "Main (Kubernetes)");
  assert.equal(adds[0].connection, "tcp://paseo-workspaces-gateway.ns.svc:8787?password=s3%20cret");
  present = false;
  assert.equal(await syncGateway(api, c, run), null);
  assert.deepEqual(removed, ["gw"]);
  const outage = async () => {
    throw new KubernetesError("unavailable");
  };
  await assert.rejects(syncGateway(api, c, outage));
  assert.deepEqual(removed, ["gw"]);
});
