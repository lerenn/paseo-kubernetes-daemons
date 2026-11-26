import { execFile } from "node:child_process";
import type { Configuration } from "../shared/settings.js";
export class KubernetesError extends Error {
  constructor(public readonly reason: "missing" | "forbidden" | "unavailable") {
    super(
      reason === "missing"
        ? "Kubernetes resource not found."
        : reason === "forbidden"
          ? "Kubernetes access denied. Check the main daemon’s namespace Role and kubeconfig."
          : "Kubernetes request failed. Check kubectl, context, namespace and cluster connectivity.",
    );
  }
}
export type Kubectl = (args: string[], input?: unknown) => Promise<string>;
export function connection(c: Configuration): Kubectl {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "kubectl",
        [
          ...(c.context ? ["--context", c.context] : []),
          "--namespace",
          c.namespace,
          "--request-timeout=20s",
          ...args,
        ],
        { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          // Never return kubectl stderr: validation/admission errors can echo Secret payloads.
          if (error)
            reject(
              new KubernetesError(
                /\bNotFound\b|\bnot found\b|doesn.t have a resource type|could not find the requested resource/i.test(
                  stderr,
                )
                  ? "missing"
                  : /Forbidden|Unauthorized/i.test(stderr)
                    ? "forbidden"
                    : "unavailable",
              ),
            );
          else resolve(stdout);
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
    });
}
// An old CRD silently prunes spec.bootstrap.providers. Reading the CRD needs cluster RBAC, so probe
// with a strict server-side dry-run create instead: unknown fields are rejected, nothing persists.
export async function crdCurrent(run: Kubectl) {
  try {
    await run(
      ["create", "--dry-run=server", "--validate=strict", "-f", "-", "-o", "name"],
      {
        apiVersion: "daemons.paseo.sh/v1alpha1",
        kind: "PaseoDaemon",
        metadata: { name: "crd-probe" },
        spec: {
          image: "probe",
          storage: "1Gi",
          bootstrap: {
            secretName: "probe",
            configMapName: "probe",
            envSecretName: "probe-env",
            providers: {
              secretName: "probe",
              configMapName: "probe",
              envSecretName: "probe-env",
              profiles: ["probe"],
            },
            plugins: [{ source: "probe", ref: "probe", configSecretName: "probe" }],
          },
          docker: { enabled: false, dataSize: "1Gi" },
          resources: {
            requests: { cpu: "1m", memory: "1Mi", "ephemeral-storage": "1Mi" },
            limits: { cpu: "1m", memory: "1Mi", "ephemeral-storage": "1Mi" },
          },
        },
      },
    );
    return true;
  } catch {
    return false;
  }
}
export async function inspect(c: Configuration, run = connection(c)) {
  try {
    let context = c.context;
    if (!context) {
      try {
        context = (await run(["config", "current-context"])).trim();
      } catch {
        context = "in-cluster / default";
      }
    }
    await run(["get", "paseodaemons.daemons.paseo.sh", "-o", "name"]);
    const deployment = JSON.parse(
      await run([
        "get",
        "deployment",
        "paseo-daemons-operator",
        "-o",
        "json",
      ]),
    ) as {
      spec?: { replicas?: number };
      status?: { availableReplicas?: number; observedGeneration?: number };
      metadata?: { generation?: number };
    };
    const ready =
      (deployment.status?.availableReplicas ?? 0) > 0 &&
      (deployment.status?.observedGeneration ?? 0) >=
        (deployment.metadata?.generation ?? 1);
    return {
      context,
      namespace: c.namespace,
      crdCurrent: ready ? await crdCurrent(run) : false,
      operator: ready ? ("ready" as const) : ("unavailable" as const),
      message: ready
        ? "Operator is ready."
        : "Operator exists but is not ready. Check its Deployment and logs.",
    };
  } catch (error) {
    return {
      context: c.context,
      namespace: c.namespace,
      crdCurrent: false,
      operator:
        error instanceof KubernetesError && error.reason === "missing"
          ? ("missing" as const)
          : ("unavailable" as const),
      message:
        error instanceof KubernetesError && error.reason === "missing"
          ? "Install the CRD and operator in this namespace."
          : error instanceof KubernetesError
            ? error.message
            : "Unable to inspect the operator.",
    };
  }
}
export async function applyOwned(
  run: Kubectl,
  object: Record<string, unknown>,
  owner: string,
) {
  const metadata = object.metadata as { name: string };
  const kind = String(object.kind).toLowerCase();
  // Metadata-only reads: existing Secret values never enter error messages or responses.
  const saved = await run([
    "get",
    kind,
    metadata.name,
    "--ignore-not-found",
    "-o",
    "jsonpath={.metadata.labels.workspaces\\.paseo\\.sh/profile-owner}",
  ]);
  if (saved && saved !== owner)
    throw new Error(
      "A profile resource with this name belongs to another installation.",
    );
  // Distinguish an absent object from a foreign object without the ownership label.
  if (!saved) {
    const exists = await run([
      "get",
      kind,
      metadata.name,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    if (exists.trim())
      throw new Error("Refusing to overwrite an unmanaged profile resource.");
  }
  await run(
    [
      "apply",
      "--server-side",
      "--field-manager=paseo-daemons-profile",
      "-f",
      "-",
      "-o",
      "name",
    ],
    object,
  );
}
