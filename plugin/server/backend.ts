import type { PaseoApi } from "@getpaseo/client";
import { nameSchema } from "../shared/contracts.js";
import {
  settingsSchema,
  scopeOf,
  type Configuration,
} from "../shared/settings.js";
import { connection, KubernetesError, type Kubectl } from "./kubernetes.js";

export interface Environment {
  metadata: { name: string; uid: string; deletionTimestamp?: string };
  spec?: { workingDirectory?: string };
  status?: { phase?: string; endpoint?: string; message?: string };
}
export function defaults(): Configuration {
  return settingsSchema.parse({
    namespace: process.env.PASEO_WORKSPACE_NAMESPACE ?? "paseo-workspaces",
    clusterId: process.env.PASEO_WORKSPACE_CLUSTER_ID ?? "default",
    image: process.env.PASEO_WORKSPACE_IMAGE ?? "",
    mainConnection: process.env.PASEO_MAIN_CONNECTION ?? "",
  });
}
export async function create(name: string, c: Configuration = defaults()) {
  nameSchema.parse(name);
  const image = c.image;
  const kubectl = connection(c);
  if (c.bundle && c.bundle.scope !== scopeOf(c))
    throw new Error(
      "Sync credentials for this Kubernetes connection before creating an environment.",
    );
  if (!image)
    throw new Error("Set a workspace image in Kubernetes Workspaces settings.");
  // Server-side apply is idempotent. The CR spec is immutable after creation.
  return JSON.parse(
    await kubectl(
      [
        "apply",
        "--server-side",
        "--field-manager=paseo-plugin",
        "-f",
        "-",
        "-o",
        "json",
      ],
      {
        apiVersion: "workspaces.paseo.sh/v1alpha1",
        kind: "PaseoWorkspace",
        metadata: { name },
        spec: {
          image,
          storage: c.ephemeral ? "4Gi" : "10Gi",
          ephemeral: c.ephemeral,
          docker: { enabled: c.docker },
          ...(c.bundle
            ? {
                bootstrap: {
                  secretName: c.bundle.name,
                  configMapName: c.bundle.name,
                  envSecretName: c.bundle.name + "-env",
                },
                workingDirectory: c.bundle.repository
                  ? "/workspace/repository"
                  : "/workspace",
              }
            : {}),
          resources: {
            requests: {
              cpu: "250m",
              memory: "512Mi",
              "ephemeral-storage": "1Gi",
            },
            limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "4Gi" },
          },
          ...(process.env.PASEO_WORKSPACE_SECRET
            ? { secretName: process.env.PASEO_WORKSPACE_SECRET }
            : {}),
        },
      },
    ),
  );
}
const manager = "paseo-kubernetes-workspaces";
export async function syncHosts(
  paseo: PaseoApi,
  environments: Environment[],
  c: Configuration = defaults(),
) {
  const namespace = c.namespace;
  const scope = `${c.context ? c.context + "/" : ""}${c.clusterId}/${namespace}`;
  const directory = await paseo.hosts.list();
  const live = new Set(environments.map((e) => e.metadata.uid));
  // List must succeed before this function is called: API outages cannot erase registrations.
  for (const host of directory.hosts) {
    if (
      host.metadata.manager === manager &&
      host.metadata.scope === scope &&
      host.metadata.workspaceUid !== undefined &&
      !live.has(host.metadata.workspaceUid)
    ) {
      await paseo.hosts.remove(host.registrationId);
    }
  }
  const results = [];
  for (const env of environments) {
    let host = directory.hosts.find(
      (h) =>
        h.metadata.manager === manager &&
        h.metadata.scope === scope &&
        h.metadata.workspaceUid === env.metadata.uid,
    );
    if (
      !env.metadata.deletionTimestamp &&
      env.status?.phase === "Ready" &&
      env.status.endpoint
    ) {
      host = await paseo.hosts.add({
        connection: env.status.endpoint,
        label: `Kubernetes Pod pw-${env.metadata.name}`,
        sourceKey: `kubernetes/${scope}/${env.metadata.uid}`,
        metadata: { manager, scope, workspaceUid: env.metadata.uid },
      });
      if (host.status === "online" && host.serverId && c.mainConnection) {
        const remote = await paseo.hosts.client(host.serverId);
        await remote.hosts.add({
          connection: c.mainConnection,
          label: "Main daemon",
          sourceKey: `kubernetes-main/${scope}`,
        });
      }
    }
    results.push({
      name: env.metadata.name,
      phase: env.metadata.deletionTimestamp
        ? "Deleting"
        : (env.status?.phase ?? "Pending"),
      message: env.status?.message ?? "",
      cwd: env.spec?.workingDirectory ?? "/workspace",
      serverId: host?.serverId ?? null,
      hostStatus: host?.status ?? null,
      error: host?.error ?? null,
    });
  }
  return results;
}
const gatewayService = "paseo-workspaces-gateway";
const gatewaySecret = "paseo-workspaces-gateway-auth";
const gatewayPort = 8787;
/**
 * Registers the operator's virtual "<Name> (Kubernetes)" host while the gateway is enabled,
 * and removes it once its identity Secret is gone. Failures other than "missing" leave the
 * registration untouched so an API outage cannot erase it.
 */
export async function syncGateway(
  paseo: PaseoApi,
  c: Configuration = defaults(),
  run: Kubectl = connection(c),
) {
  const scope = `${c.context ? c.context + "/" : ""}${c.clusterId}/${c.namespace}`;
  const directory = await paseo.hosts.list();
  const existing = directory.hosts.filter(
    (h) =>
      h.metadata.manager === manager &&
      h.metadata.scope === scope &&
      h.metadata.gateway === "true",
  );
  let password = "";
  try {
    const secret = JSON.parse(
      await run(["get", "secret", gatewaySecret, "-o", "json"]),
    ) as { data?: Record<string, string> };
    password = Buffer.from(secret.data?.password ?? "", "base64").toString();
  } catch (error) {
    if (!(error instanceof KubernetesError) || error.reason !== "missing")
      throw error;
  }
  if (!password) {
    for (const host of existing) await paseo.hosts.remove(host.registrationId);
    return null;
  }
  const name = directory.self.label || c.clusterId;
  return paseo.hosts.add({
    connection: `tcp://${gatewayService}.${c.namespace}.svc:${gatewayPort}?password=${encodeURIComponent(password)}`,
    label: `${name} (Kubernetes)`,
    sourceKey: `kubernetes-gateway/${scope}`,
    metadata: { manager, scope, gateway: "true" },
  });
}
const inFlight = new Map<
  string,
  Promise<Awaited<ReturnType<typeof syncHosts>>>
>();
export function list(paseo: PaseoApi, c: Configuration = defaults()) {
  const key = scopeOf(c) + c.mainConnection;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = reconcile(paseo, c).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}
async function reconcile(paseo: PaseoApi, c: Configuration) {
  const result = JSON.parse(
    await connection(c)([
      "get",
      "paseoworkspaces.workspaces.paseo.sh",
      "-o",
      "json",
    ]),
  ) as { items: Environment[] };
  const environments = await syncHosts(paseo, result.items, c);
  // A gateway problem must not hide the pod hosts that did reconcile.
  await syncGateway(paseo, c).catch(() => {
    console.error("Kubernetes gateway host registration failed. Retrying.");
  });
  return environments;
}
export async function release(name: string, c: Configuration = defaults()) {
  nameSchema.parse(name);
  await connection(c)([
    "delete",
    "paseoworkspaces.workspaces.paseo.sh",
    name,
    "--ignore-not-found",
    "--wait=false",
  ]);
  return { name, deleting: true };
}
