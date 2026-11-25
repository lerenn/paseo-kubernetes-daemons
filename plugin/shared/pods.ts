import { z } from "zod";

// Pod settings of workspaces created by the gateway (docs/design/projects-tab.md section 6).
// Quantities are Kubernetes quantity strings. The defaults are exactly the values the gateway used
// before these settings existed; mirrored in Go by internal/gateway/pods.go.
const quantity = z.string().max(32);
export const computeSchema = z.object({
  cpuRequest: quantity.default("250m"),
  cpuLimit: quantity.default("2"),
  memoryRequest: quantity.default("512Mi"),
  memoryLimit: quantity.default("4Gi"),
  // "Scratch space": the pod's ephemeral-storage request and limit.
  scratchRequest: quantity.default("1Gi"),
  scratchLimit: quantity.default("4Gi"),
});
export const storageSchema = z.object({
  // Empty means the mode default: 4Gi for ephemeral pods, 10Gi for persistent ones.
  size: quantity.default(""),
  // Empty means the cluster default class. Ignored for ephemeral pods.
  storageClassName: z.string().max(253).default(""),
});
export const dockerPodSchema = z.object({
  cpuRequest: quantity.default("250m"),
  cpuLimit: quantity.default("2"),
  memoryRequest: quantity.default("256Mi"),
  memoryLimit: quantity.default("2Gi"),
  scratchRequest: quantity.default("1Gi"),
  scratchLimit: quantity.default("12Gi"),
  dataSize: quantity.default("10Gi"),
});
export const podsSchema = z.object({
  compute: computeSchema.default(computeSchema.parse({})),
  storage: storageSchema.default(storageSchema.parse({})),
  docker: dockerPodSchema.default(dockerPodSchema.parse({})),
});
export type Pods = z.output<typeof podsSchema>;
// Per-project override: the same shape, every field optional; absent fields use the global value.
export const podsOverrideSchema = z.object({
  compute: computeSchema.partial().optional(),
  storage: storageSchema.partial().optional(),
  docker: dockerPodSchema.partial().optional(),
});
export type PodsOverride = z.output<typeof podsOverrideSchema>;
export const defaultPods = (): Pods => podsSchema.parse({});

export function mergePods(base: Pods, override?: PodsOverride): Pods {
  const pick = <T extends object>(b: T, o?: Partial<T>): T => {
    const out = { ...b };
    for (const [k, v] of Object.entries(o ?? {}))
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    return out;
  };
  return {
    compute: pick(base.compute, override?.compute),
    storage: pick(base.storage, override?.storage),
    docker: pick(base.docker, override?.docker),
  };
}

const BINARY: Record<string, number> = {
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
};
const DECIMAL: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
};
// Parses a Kubernetes quantity into a plain number (cores, bytes, count); null when malformed.
export function parseQuantity(value: string): number | null {
  const m = /^([+]?(?:\d+\.?\d*|\.\d+))(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E)?$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const factor = m[2] === undefined ? 1 : (BINARY[m[2]] ?? DECIMAL[m[2]]);
  const result = n * factor;
  return Number.isFinite(result) ? result : null;
}

const GI = 1024 ** 3;
const MAX_CPU = 256;
const MAX_MEMORY = 4096 * GI;
const MAX_STORAGE = 100 * 1024 * GI;
const STORAGE_CLASS = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export type PodsIssue = { path: string; message: string };

function pair(
  issues: PodsIssue[],
  group: string,
  name: string,
  request: string,
  limit: string,
  max: number,
) {
  const r = parseQuantity(request);
  const l = parseQuantity(limit);
  for (const [field, raw, n] of [
    [`${name}Request`, request, r],
    [`${name}Limit`, limit, l],
  ] as const) {
    if (n === null) issues.push({ path: `${group}.${field}`, message: `"${raw}" is not a valid quantity.` });
    else if (n <= 0) issues.push({ path: `${group}.${field}`, message: "Must be greater than zero." });
    else if (n > max) issues.push({ path: `${group}.${field}`, message: "Exceeds the supported maximum." });
  }
  if (r !== null && l !== null && r > 0 && l > 0 && r > l)
    issues.push({ path: `${group}.${name}Request`, message: "The request cannot exceed the limit." });
}
function size(issues: PodsIssue[], path: string, value: string, optional: boolean) {
  if (optional && value === "") return;
  const n = parseQuantity(value);
  if (n === null) issues.push({ path, message: `"${value}" is not a valid quantity.` });
  else if (n < GI) issues.push({ path, message: "Must be at least 1Gi." });
  else if (n > MAX_STORAGE) issues.push({ path, message: "Exceeds the supported maximum." });
}

// Hard errors for effective (already merged) settings; mirrored by validPodSettings in Go.
// Docker values are checked even when Docker is off so a saved default never turns invalid later.
export function validatePods(p: Pods): PodsIssue[] {
  const issues: PodsIssue[] = [];
  pair(issues, "compute", "cpu", p.compute.cpuRequest, p.compute.cpuLimit, MAX_CPU);
  pair(issues, "compute", "memory", p.compute.memoryRequest, p.compute.memoryLimit, MAX_MEMORY);
  pair(issues, "compute", "scratch", p.compute.scratchRequest, p.compute.scratchLimit, MAX_STORAGE);
  size(issues, "storage.size", p.storage.size, true);
  const cls = p.storage.storageClassName;
  if (cls && !STORAGE_CLASS.test(cls))
    issues.push({ path: "storage.storageClassName", message: "Not a valid storage class name." });
  pair(issues, "docker", "cpu", p.docker.cpuRequest, p.docker.cpuLimit, MAX_CPU);
  pair(issues, "docker", "memory", p.docker.memoryRequest, p.docker.memoryLimit, MAX_MEMORY);
  pair(issues, "docker", "scratch", p.docker.scratchRequest, p.docker.scratchLimit, MAX_STORAGE);
  size(issues, "docker.dataSize", p.docker.dataSize, false);
  return issues;
}

// ---- catalog fields (internal/gateway/configuration.go ProfileConfiguration) ----
export interface CatalogResources {
  requests: { cpu: string; memory: string; "ephemeral-storage": string };
  limits: { cpu: string; memory: string; "ephemeral-storage": string };
}
export interface CatalogPods {
  resources: CatalogResources;
  storage?: string;
  storageClassName?: string;
  dockerResources?: CatalogResources;
  dockerDataSize?: string;
}
export function catalogPods(p: Pods, docker: boolean, ephemeral: boolean): CatalogPods {
  const out: CatalogPods = {
    resources: {
      requests: { cpu: p.compute.cpuRequest, memory: p.compute.memoryRequest, "ephemeral-storage": p.compute.scratchRequest },
      limits: { cpu: p.compute.cpuLimit, memory: p.compute.memoryLimit, "ephemeral-storage": p.compute.scratchLimit },
    },
  };
  if (p.storage.size) out.storage = p.storage.size;
  if (!ephemeral && p.storage.storageClassName) out.storageClassName = p.storage.storageClassName;
  if (docker) {
    out.dockerResources = {
      requests: { cpu: p.docker.cpuRequest, memory: p.docker.memoryRequest, "ephemeral-storage": p.docker.scratchRequest },
      limits: { cpu: p.docker.cpuLimit, memory: p.docker.memoryLimit, "ephemeral-storage": p.docker.scratchLimit },
    };
    out.dockerDataSize = p.docker.dataSize;
  }
  return out;
}

// ---- warnings from cluster facts (never errors: a quota or class can change) ----
export interface QuotaInfo { name: string; hard: Record<string, string> }
export interface StorageClassInfo { name: string; isDefault: boolean; allowVolumeExpansion: boolean; provisioner: string }

export interface PodEstimate {
  requests: { cpu: number; memory: number; scratch: number };
  limits: { cpu: number; memory: number; scratch: number };
  // PVC size (persistent) or 0.
  storage: number;
}
export function estimate(p: Pods, docker: boolean, ephemeral: boolean): PodEstimate {
  const q = (v: string) => parseQuantity(v) ?? 0;
  const d = docker ? 1 : 0;
  const defaultSize = ephemeral ? 4 * GI : 10 * GI;
  return {
    requests: {
      cpu: q(p.compute.cpuRequest) + d * q(p.docker.cpuRequest),
      memory: q(p.compute.memoryRequest) + d * q(p.docker.memoryRequest),
      scratch: q(p.compute.scratchRequest) + d * q(p.docker.scratchRequest),
    },
    limits: {
      cpu: q(p.compute.cpuLimit) + d * q(p.docker.cpuLimit),
      memory: q(p.compute.memoryLimit) + d * q(p.docker.memoryLimit),
      scratch: q(p.compute.scratchLimit) + d * q(p.docker.scratchLimit),
    },
    storage: ephemeral ? 0 : (q(p.storage.size) || defaultSize),
  };
}

// Per-quota-key amount one pod needs, for the keys a ResourceQuota commonly constrains.
function perPod(e: PodEstimate): Record<string, number> {
  return {
    pods: 1,
    "requests.cpu": e.requests.cpu,
    cpu: e.requests.cpu,
    "limits.cpu": e.limits.cpu,
    "requests.memory": e.requests.memory,
    memory: e.requests.memory,
    "limits.memory": e.limits.memory,
    "requests.ephemeral-storage": e.requests.scratch,
    ephemeral_storage: e.requests.scratch,
    "ephemeral-storage": e.requests.scratch,
    "limits.ephemeral-storage": e.limits.scratch,
    "requests.storage": e.storage,
    persistentvolumeclaims: e.storage > 0 ? 1 : 0,
  };
}

// How many pods the quota admits (the tightest key), or null when no key constrains pods.
export function podsThatFit(e: PodEstimate, quotas: QuotaInfo[]): number | null {
  const need = perPod(e);
  let fit: number | null = null;
  for (const quota of quotas)
    for (const [key, raw] of Object.entries(quota.hard)) {
      const per = need[key];
      const hard = parseQuantity(raw);
      if (!per || hard === null) continue;
      const n = Math.floor(hard / per);
      fit = fit === null ? n : Math.min(fit, n);
    }
  return fit;
}

export function podWarnings(
  p: Pods,
  docker: boolean,
  ephemeral: boolean,
  quotas: QuotaInfo[] | null,
  classes: StorageClassInfo[] | null,
): string[] {
  const warnings: string[] = [];
  const e = estimate(p, docker, ephemeral);
  const need = perPod(e);
  for (const quota of quotas ?? [])
    for (const [key, raw] of Object.entries(quota.hard)) {
      const per = need[key];
      const hard = parseQuantity(raw);
      if (!per || hard === null) continue;
      if (per > hard)
        warnings.push(`One pod needs more than the quota "${quota.name}" allows for ${key} (${raw}); pod creation will be rejected.`);
    }
  const fit = podsThatFit(e, quotas ?? []);
  if (fit !== null && fit < 1 && !warnings.length) warnings.push("The namespace quota does not admit a single pod with these settings.");
  const cls = p.storage.storageClassName;
  if (!ephemeral && classes) {
    if (cls && !classes.some((c) => c.name === cls))
      warnings.push(`Storage class "${cls}" does not exist; the volume would stay unbound.`);
    const used = cls ? classes.find((c) => c.name === cls) : classes.find((c) => c.isDefault);
    if (used && !used.allowVolumeExpansion)
      warnings.push(`Storage class "${used.name}" does not allow volume expansion; a workspace volume cannot be grown later.`);
  }
  return warnings;
}
