import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaseoApi } from "@getpaseo/client";
import { syncHosts, syncGateway, logGatewayError, redact, create, release, defaults } from "./backend.js";
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
    return JSON.stringify({ data: { password: Buffer.from("s3 cret").toString("base64") } });
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

test("syncGateway registers the public TLS endpoint when one is configured", async () => {
  const adds: any[] = [];
  const api = {
    hosts: {
      list: async () => ({ self: { serverId: "m", label: "Main" }, hosts: [] }),
      add: async (i: unknown) => (adds.push(i), { serverId: "g", status: "online" }),
      remove: async () => {},
    },
  } as unknown as PaseoApi;
  const run = async () => JSON.stringify({ data: { password: Buffer.from("pw").toString("base64") } });
  const base = { ...defaults(), namespace: "ns", clusterId: "c1", context: "" };
  await syncGateway(api, { ...base, gatewayEndpoint: "workspaces.example.net" }, run);
  await syncGateway(api, { ...base, gatewayEndpoint: "w.example.net:8443" }, run);
  assert.equal(adds[0].connection, "tcp://workspaces.example.net:443?ssl=true&password=pw");
  assert.equal(adds[1].connection, "tcp://w.example.net:8443?ssl=true&password=pw");
});

test("gateway failures are logged redacted, with context, once per interval", async () => {
  const api = {
    hosts: {
      list: async () => ({ self: { serverId: "m", label: "Main" }, hosts: [] }),
      add: async () => {
        throw new Error("dial tcp: tcp://h:443?ssl=true&password=s3%20cret failed for s3 cret");
      },
      remove: async () => {},
    },
  } as unknown as PaseoApi;
  const run = async () => JSON.stringify({ data: { password: Buffer.from("s3 cret").toString("base64") } });
  const c = { ...defaults(), namespace: "ns", clusterId: "c1", context: "" };
  const error = await syncGateway(api, c, run).then(() => null, (e) => e);
  const lines: string[] = [];
  const log = (m: string) => lines.push(m);
  logGatewayError(error, log, 1_000_000);
  logGatewayError(error, log, 1_005_000);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /hosts\.add: /);
  assert.doesNotMatch(lines[0], /s3|cret/);
  logGatewayError(error, log, 1_000_000 + 6 * 60_000);
  assert.equal(lines.length, 2);
  assert.equal(redact(new Error("x password=abc&y=1")), "x password=[redacted]&y=1");
});

test("syncGateway updates an existing registration instead of adding (source_conflict)", async () => {
  const calls: string[] = [];
  const api = {
    hosts: {
      list: async () => ({
        self: { serverId: "m", label: "Main" },
        hosts: [{ registrationId: "old", metadata: {}, source: { id: "p", key: "kubernetes-gateway/c1/ns" } }],
      }),
      add: async () => {
        calls.push("add");
        throw new Error("source_conflict");
      },
      update: async (id: string, patch: { connection: string }) => {
        calls.push(`update:${id}:${patch.connection}`);
        return { serverId: "g", status: "online" };
      },
      remove: async () => {},
    },
  } as unknown as PaseoApi;
  const run = async () => JSON.stringify({ data: { password: Buffer.from("pw").toString("base64") } });
  const c = { ...defaults(), namespace: "ns", clusterId: "c1", context: "", gatewayEndpoint: "w.example.net" };
  await syncGateway(api, c, run);
  assert.deepEqual(calls, ["update:old:tcp://w.example.net:443?ssl=true&password=pw"]);
});

test("syncGateway uses the custom gatewayHostName as the label when set", async () => {
  const adds: any[] = [];
  const api = {
    hosts: {
      list: async () => ({ self: { serverId: "m", label: "Main" }, hosts: [] }),
      add: async (i: unknown) => (adds.push(i), { serverId: "g", status: "online" }),
      remove: async () => {},
    },
  } as unknown as PaseoApi;
  const run = async () => JSON.stringify({ data: { password: Buffer.from("pw").toString("base64") } });
  const base = { ...defaults(), namespace: "ns", clusterId: "c1", context: "" };
  await syncGateway(api, { ...base, gatewayHostName: "  Anyshift Lab  " }, run);
  assert.equal(adds[0].label, "Anyshift Lab");
  await syncGateway(api, { ...base, gatewayHostName: "" }, run);
  assert.equal(adds[1].label, "Main (Kubernetes)");
});

test("syncGateway does not resend an unchanged connection (it would restart the host link and drop routes)", async () => {
  const updates: unknown[] = [];
  const host = { registrationId: "stable", label: "Main (Kubernetes)", metadata: { manager: "paseo-kubernetes-workspaces", scope: "c9/ns", gateway: "true" }, source: { id: "p", key: "kubernetes-gateway/c9/ns" } };
  const api = {
    hosts: {
      list: async () => ({ self: { serverId: "m", label: "Main" }, hosts: [host] }),
      add: async () => { throw new Error("source_conflict"); },
      update: async (_id: string, patch: unknown) => { updates.push(patch); return host; },
      remove: async () => {},
    },
  } as unknown as PaseoApi;
  const run = async () => JSON.stringify({ data: { password: Buffer.from("pw").toString("base64") } });
  const c = { ...defaults(), namespace: "ns", clusterId: "c9", context: "", gatewayEndpoint: "w.example.net" };
  await syncGateway(api, c, run);
  await syncGateway(api, c, run);
  await syncGateway(api, c, run);
  assert.equal(updates.length, 1);
  await syncGateway(api, { ...c, gatewayEndpoint: "other.example.net" }, run);
  assert.equal(updates.length, 2);
});
