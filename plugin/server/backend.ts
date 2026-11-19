import { execFile } from 'node:child_process';
import type { PaseoApi } from '@getpaseo/client';
import { nameSchema } from '../shared/contracts.js';

export interface Environment {
  metadata: { name: string; uid: string; deletionTimestamp?: string };
  status?: { phase?: string; endpoint?: string };
}
export function kubectl(args: string[], input?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('kubectl', ['--namespace', process.env.PASEO_WORKSPACE_NAMESPACE ?? 'paseo-workspaces', ...args],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`kubectl failed: ${stderr.trim() || error.message}`)); else resolve(stdout);
      });
    child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
export async function create(name: string) {
  nameSchema.parse(name);
  const image = process.env.PASEO_WORKSPACE_IMAGE;
  if (!image) throw new Error('Set PASEO_WORKSPACE_IMAGE on the main daemon');
  // Server-side apply is idempotent. The CR spec is immutable after creation.
  return JSON.parse(await kubectl(['apply', '--server-side', '--field-manager=paseo-plugin', '-f', '-', '-o', 'json'], {
    apiVersion: 'workspaces.paseo.sh/v1alpha1', kind: 'PaseoWorkspace', metadata: { name },
    spec: { image, storage: '10Gi', resources: {
      requests: { cpu: '250m', memory: '512Mi', 'ephemeral-storage': '1Gi' },
      limits: { cpu: '2', memory: '4Gi', 'ephemeral-storage': '4Gi' },
    }, ...(process.env.PASEO_WORKSPACE_SECRET ? { secretName: process.env.PASEO_WORKSPACE_SECRET } : {}) },
  }));
}
const manager = 'paseo-kubernetes-workspaces';
export async function syncHosts(paseo: PaseoApi, environments: Environment[]) {
  const namespace = process.env.PASEO_WORKSPACE_NAMESPACE ?? 'paseo-workspaces';
  const scope = `${process.env.PASEO_WORKSPACE_CLUSTER_ID ?? 'default'}/${namespace}`;
  const directory = await paseo.hosts.list();
  const live = new Set(environments.map(e => e.metadata.uid));
  // List must succeed before this function is called: API outages cannot erase registrations.
  for (const host of directory.hosts) {
    if (host.metadata.manager === manager && host.metadata.scope === scope && !live.has(host.metadata.workspaceUid)) {
      await paseo.hosts.remove(host.registrationId);
    }
  }
  const results = [];
  for (const env of environments) {
    let host = directory.hosts.find(h => h.metadata.manager === manager && h.metadata.scope === scope && h.metadata.workspaceUid === env.metadata.uid);
    if (!env.metadata.deletionTimestamp && env.status?.phase === 'Ready' && env.status.endpoint) {
      host = await paseo.hosts.add({ connection: env.status.endpoint, label: env.metadata.name,
        sourceKey: `kubernetes/${scope}/${env.metadata.uid}`, metadata: { manager, scope, workspaceUid: env.metadata.uid } });
      if (host.status === 'online' && host.serverId && process.env.PASEO_MAIN_CONNECTION) {
        const remote = await paseo.hosts.client(host.serverId);
        await remote.hosts.add({ connection: process.env.PASEO_MAIN_CONNECTION, label: 'Main daemon', sourceKey: `kubernetes-main/${scope}` });
      }
    }
    results.push({ name: env.metadata.name, phase: env.metadata.deletionTimestamp ? 'Deleting' : env.status?.phase ?? 'Pending',
      serverId: host?.serverId ?? null, hostStatus: host?.status ?? null, error: host?.error ?? null });
  }
  return results;
}
let inFlight: Promise<Awaited<ReturnType<typeof syncHosts>>> | undefined;
export function list(paseo: PaseoApi) {
  if (!inFlight) inFlight = reconcile(paseo).finally(() => { inFlight = undefined; });
  return inFlight;
}
async function reconcile(paseo: PaseoApi) {
  const result = JSON.parse(await kubectl(['get', 'paseoworkspaces.workspaces.paseo.sh', '-o', 'json'])) as {items: Environment[]};
  return syncHosts(paseo, result.items);
}
export async function release(name: string) {
  nameSchema.parse(name);
  await kubectl(['delete', 'paseoworkspaces.workspaces.paseo.sh', name, '--ignore-not-found', '--wait=false']);
  return { name, deleting: true };
}
