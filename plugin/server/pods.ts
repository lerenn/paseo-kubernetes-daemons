import type { Configuration } from "../shared/settings.js";
import {
  defaultPods,
  estimate,
  mergePods,
  podsThatFit,
  podWarnings,
  validatePods,
  type Pods,
  type PodsOverride,
  type QuotaInfo,
  type StorageClassInfo,
} from "../shared/pods.js";
import type { Kubectl } from "./kubernetes.js";

// Both reads are optional: without RBAC (namespaced resourcequotas, cluster-scoped storageclasses)
// they yield null and the UI degrades silently.
export async function readQuotas(run: Kubectl): Promise<QuotaInfo[] | null> {
  try {
    const list = JSON.parse(await run(["get", "resourcequotas", "-o", "json"])) as {
      items?: { metadata?: { name?: string }; spec?: { hard?: Record<string, string> } }[];
    };
    return (list.items ?? []).map((q) => ({
      name: q.metadata?.name ?? "",
      hard: Object.fromEntries(
        Object.entries(q.spec?.hard ?? {}).filter(([, v]) => typeof v === "string"),
      ),
    }));
  } catch {
    return null;
  }
}
export async function readStorageClasses(run: Kubectl): Promise<StorageClassInfo[] | null> {
  try {
    const list = JSON.parse(await run(["get", "storageclasses", "-o", "json"])) as {
      items?: {
        metadata?: { name?: string; annotations?: Record<string, string> };
        provisioner?: string;
        allowVolumeExpansion?: boolean;
      }[];
    };
    return (list.items ?? []).map((c) => ({
      name: c.metadata?.name ?? "",
      isDefault: c.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true",
      allowVolumeExpansion: c.allowVolumeExpansion === true,
      provisioner: c.provisioner ?? "",
    }));
  } catch {
    return null;
  }
}

export async function podsStatus(c: Configuration, run: Kubectl) {
  const [quotas, storageClasses] = await Promise.all([readQuotas(run), readStorageClasses(run)]);
  return {
    pods: c.pods,
    builtin: defaultPods(),
    issues: validatePods(c.pods),
    quotas,
    storageClasses,
  };
}

export async function podsCheck(
  input: { pods: Pods; override?: PodsOverride; docker?: boolean; ephemeral?: boolean },
  c: Configuration,
  run: Kubectl,
) {
  const effective = mergePods(input.pods, input.override);
  const docker = input.docker ?? c.docker;
  const ephemeral = input.ephemeral ?? c.ephemeral;
  const [quotas, classes] = await Promise.all([readQuotas(run), readStorageClasses(run)]);
  const perPod = estimate(effective, docker, ephemeral);
  return {
    errors: validatePods(effective),
    warnings: podWarnings(effective, docker, ephemeral, quotas, classes),
    perPod,
    fit: quotas ? podsThatFit(perPod, quotas) : null,
  };
}
