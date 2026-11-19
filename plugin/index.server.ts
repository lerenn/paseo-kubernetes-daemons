import type { PaseoApi } from '@getpaseo/client';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { defineAgentTool } from '@getpaseo/plugin/server';
import { z } from 'zod';
import { createEnvironment, listEnvironments, releaseEnvironment, requestSchema } from './contracts.js';
import { create, list, release } from './backend.js';

export default function contribute(server: PluginServerContext) {
  let active: PaseoApi | undefined;
  let busy = false;
  let stopped = false;
  const attach = (paseo: PaseoApi) => { active = paseo; };
  const timer = setInterval(async () => {
    if (!active || busy || stopped) return;
    busy = true;
    try { await list(active); }
    catch { console.error('Workspace reconciliation failed; check Kubernetes connectivity and host registration permissions. Retrying.'); }
    finally { busy = false; }
  }, 5000);
  timer.unref();
  server.handle(createEnvironment, async ({name}, {paseo}) => { attach(paseo); await create(name); return list(paseo); });
  server.handle(listEnvironments, async (_, {paseo}) => { attach(paseo); return list(paseo); });
  server.handle(releaseEnvironment, async ({name}) => release(name));
  const removeHook = server.addHook('agent.open.before', async ({request}, {paseo}) => { attach(paseo); return ({...request, tools: [...request.tools,
    defineAgentTool({ name: 'kubernetes_workspace_create', description: 'Request an isolated workspace daemon. Poll kubernetes_workspace_list until hostStatus is online, then use its serverId with cross-host tools.', input: requestSchema,
      execute: async ({name}, {paseo}) => { await create(name); return {structuredContent: await list(paseo)}; } }),
    defineAgentTool({ name: 'kubernetes_workspace_list', description: 'List environments and reconcile forward/reverse daemon registrations. Returns remote serverIds.', input: z.object({}),
      execute: async (_, {paseo}) => ({structuredContent: await list(paseo)}) }),
    defineAgentTool({ name: 'kubernetes_workspace_release', description: 'Delete an environment, including its pod and persistent storage. Export results first.', input: requestSchema,
      execute: async ({name}) => ({structuredContent: await release(name)}) }),
  ]}); });
  return () => { stopped = true; clearInterval(timer); removeHook(); };
}
