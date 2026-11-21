import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  createEnvironment,
  listEnvironments,
  releaseEnvironment,
  requestSchema,
} from "./shared/contracts.js";
import { create, list, release, defaults } from "./server/backend.js";
import { workspaceSettings, settingsSchema } from "./shared/settings.js";
import { inspect } from "./server/kubernetes.js";
import { discover, sync } from "./server/credentials.js";
import { captureControls } from "./server/provider-profile.js";
import {
  inspectSetup,
  discoverSources,
  syncCredentials,
  openEnvironment,
} from "./shared/contracts.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(workspaceSettings);
  async function configuration() {
    const state = await settings.read();
    if (state.status !== "ready")
      throw new Error(
        "Workspace settings are invalid. Open Kubernetes Workspaces to fix them.",
      );
    return settingsSchema.parse({
      ...defaults(),
      ...state.values,
      image: state.values.image || defaults().image,
      mainConnection: state.values.mainConnection || defaults().mainConnection,
      gatewayEndpoint:
        state.values.gatewayEndpoint || defaults().gatewayEndpoint,
    });
  }
  server.handle(inspectSetup, async (_, { paseo }) => {
    const result = await inspect(await configuration());
    if (result.operator === "ready") attach(paseo);
    return result;
  });
  server.handle(discoverSources, async ({ repositoryPath }) =>
    discover(repositoryPath),
  );
  server.handle(syncCredentials, async (selection, { paseo }) => {
    const directory = await paseo.hosts.list();
    const snapshot = await paseo.providers.waitForReady({cwd: selection.repositoryPath || undefined});
    const controls = await captureControls(paseo,snapshot,selection.providers,selection.repositoryPath || process.cwd());
    return sync(await configuration(), selection, directory.self.serverId, undefined, undefined, snapshot,controls);
  });
  let active: PaseoApi | undefined;
  let busy = false;
  let stopped = false;
  const attach = (paseo: PaseoApi) => {
    active = paseo;
  };
  const timer = setInterval(async () => {
    if (!active || busy || stopped) return;
    busy = true;
    try {
      await list(active, await configuration());
    } catch {
      console.error(
        "Workspace reconciliation failed; check Kubernetes connectivity and host registration permissions. Retrying.",
      );
    } finally {
      busy = false;
    }
  }, 5000);
  timer.unref();
  server.handle(createEnvironment, async ({ name }, { paseo }) => {
    attach(paseo);
    await create(name, await configuration());
    return list(paseo, await configuration());
  });
  server.handle(listEnvironments, async (_, { paseo }) => {
    attach(paseo);
    return list(paseo, await configuration());
  });
  server.handle(openEnvironment, async ({ name }, { paseo }) => {
    const environments = await list(paseo, await configuration());
    const env = environments.find((e) => e.name === name);
    if (!env?.serverId || env.hostStatus !== "online")
      throw new Error(
        "Wait for this environment to be online before opening it.",
      );
    const remote = await paseo.hosts.client(env.serverId);
    const workspace = await remote.workspaces.open({ cwd: env.cwd });
    return { workspaceId: workspace.id, serverId: env.serverId };
  });
  server.handle(releaseEnvironment, async ({ name }) =>
    release(name, await configuration()),
  );
  const removeHook = server.addHook(
    "agent.open.before",
    async ({ request }, { paseo }) => {
      attach(paseo);
      return {
        ...request,
        tools: [
          ...request.tools,
          defineAgentTool({
            name: "kubernetes_workspace_create",
            description:
              "Request an isolated workspace daemon. Poll kubernetes_workspace_list until hostStatus is online, then use its serverId with cross-host tools.",
            input: requestSchema,
            execute: async ({ name }, { paseo }) => {
              await create(name, await configuration());
              return {
                structuredContent: await list(paseo, await configuration()),
              };
            },
          }),
          defineAgentTool({
            name: "kubernetes_workspace_list",
            description:
              "List environments and reconcile forward/reverse daemon registrations. Returns remote serverIds.",
            input: z.object({}),
            execute: async (_, { paseo }) => ({
              structuredContent: await list(paseo, await configuration()),
            }),
          }),
          defineAgentTool({
            name: "kubernetes_workspace_release",
            description:
              "Delete an environment, including its pod and persistent storage. Export results first.",
            input: requestSchema,
            execute: async ({ name }) => ({
              structuredContent: await release(name, await configuration()),
            }),
          }),
        ],
      };
    },
  );
  return () => {
    stopped = true;
    clearInterval(timer);
    removeHook();
  };
}
