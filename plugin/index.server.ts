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
import { reconcile, type MigrationDeps } from "./server/migration.js";
import { workspaceSettings, settingsSchema, type Configuration } from "./shared/settings.js";
import { connection, inspect } from "./server/kubernetes.js";
import { discover, sync } from "./server/credentials.js";
import { captureControls } from "./server/provider-profile.js";
import {
  inspectSetup,
  discoverSources,
  syncCredentials,
  openEnvironment,
  providersStatus,
  providersSync,
  projectsList,
  projectsDiscover,
  projectsDiscoverLocal,
  projectsAdd,
  projectsUpdate,
  projectsApprove,
  projectsRemove,
  projectsSync,
  projectsCatalog,
  podsStatus,
  podsCheck,
  pluginsStatus,
  pluginsAdd,
  pluginsUpdate,
  pluginsRemove,
  pluginsSync,
} from "./shared/contracts.js";
import { addPlugin, updatePlugin, removePlugin, pluginsStatus as buildPluginsStatus, syncPlugins } from "./server/plugins.js";
import { syncAllProviders, syncOneProject, refreshCatalog } from "./server/sync.js";
import {
  addProject,
  discoverLocal,
  updateProject,
  approveProject,
  removeProject,
  projectsStatus,
  providersStatus as buildProvidersStatus,
} from "./server/projects.js";
import { podsStatus as buildPodsStatus, podsCheck as buildPodsCheck } from "./server/pods.js";
import type { SnapshotEntryLike } from "./server/daemon-providers.js";
import { discoverProject } from "./server/credentials.js";

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
      gatewayHostName:
        state.values.gatewayHostName || defaults().gatewayHostName,
    });
  }
  async function catalogDeps(paseo: PaseoApi, c: Configuration): Promise<MigrationDeps> {
    const directory = await paseo.hosts.list();
    return {
      serverId: directory.self.serverId,
      run: connection(c),
      providerContext: async (selection) => {
        const snapshot = await paseo.providers.waitForReady({});
        const controls = await captureControls(paseo, snapshot, selection.providers, process.cwd());
        const daemonProviders = (await paseo.config.get()).config.providers ?? {};
        return { snapshot, controls, daemonProviders };
      },
    };
  }
  server.handle(inspectSetup, async (_, { paseo }) => {
    const c = await configuration();
    const result = await inspect(c);
    if (result.operator !== "ready") return result;
    attach(paseo);
    // Automatic, idempotent migration of the legacy profile; never fails the inspection.
    const migration: Awaited<ReturnType<typeof reconcile>> = await reconcile(
      c,
      result,
      await catalogDeps(paseo, c),
    ).catch(() => ({ migrated: false, error: "The catalog could not be updated." }));
    return {
      ...result,
      ...(migration.split ? { split: migration.split } : {}),
      ...(migration.error ? { migrationError: migration.error } : {}),
    };
  });
  const serverId = async (paseo: PaseoApi) => (await paseo.hosts.list()).self.serverId;
  server.handle(providersStatus, async (_, { paseo }) => {
    const c = await configuration();
    let daemon: { entries: SnapshotEntryLike[]; providers: Record<string, unknown> } | null = null;
    let daemonError: string | undefined;
    try {
      const [snapshot, config] = await Promise.all([paseo.providers.snapshot(), paseo.config.get()]);
      daemon = { entries: snapshot.entries, providers: config.config.providers ?? {} };
    } catch {
      daemonError = "The main daemon's provider list could not be read.";
    }
    return buildProvidersStatus(c, connection(c), {}, daemon, daemonError);
  });
  server.handle(providersSync, async (_, { paseo }) => {
    const c = await configuration();
    return syncAllProviders(c, await catalogDeps(paseo, c));
  });
  server.handle(projectsList, async (_, { paseo }) => {
    const c = await configuration();
    return projectsStatus(c, await serverId(paseo), connection(c));
  });
  server.handle(projectsDiscoverLocal, async (_, { paseo }) =>
    discoverLocal(await configuration(), (await paseo.projects.list()).projects),
  );
  server.handle(projectsDiscover, async ({ path }) => discoverProject(path));
  server.handle(projectsAdd, async (input) => addProject(await configuration(), input));
  server.handle(projectsUpdate, async (input) => updateProject(await configuration(), input));
  server.handle(projectsApprove, async (input) => approveProject(await configuration(), input));
  server.handle(projectsRemove, async ({ id }) => {
    const c = await configuration();
    return removeProject(c, id, connection(c));
  });
  server.handle(projectsSync, async ({ id }, { paseo }) => {
    const c = await configuration();
    return syncOneProject(c, id, await catalogDeps(paseo, c));
  });
  server.handle(projectsCatalog, async (_, { paseo }) => {
    const c = await configuration();
    return refreshCatalog(c, await catalogDeps(paseo, c));
  });
  server.handle(podsStatus, async () => {
    const c = await configuration();
    return buildPodsStatus(c, connection(c));
  });
  server.handle(podsCheck, async (input) => {
    const c = await configuration();
    return buildPodsCheck(input, c, connection(c));
  });
  server.handle(pluginsStatus, async () => buildPluginsStatus(await configuration()));
  server.handle(pluginsAdd, async (input) => addPlugin(await configuration(), input));
  server.handle(pluginsUpdate, async (input) => updatePlugin(await configuration(), { ...input, ref: input.ref ?? "" }));
  server.handle(pluginsRemove, async (input) => removePlugin(await configuration(), { source: input.source, ref: input.ref ?? "" }));
  server.handle(pluginsSync, async (_, { paseo }) => {
    const c = await configuration();
    return syncPlugins(c, await catalogDeps(paseo, c));
  });
  server.handle(discoverSources, async ({ repositoryPath }) =>
    discover(repositoryPath),
  );
  server.handle(syncCredentials, async (selection, { paseo }) => {
    const directory = await paseo.hosts.list();
    const snapshot = await paseo.providers.waitForReady({cwd: selection.repositoryPath || undefined});
    const controls = await captureControls(paseo,snapshot,selection.providers,selection.repositoryPath || process.cwd());
    const c = await configuration();
    const result = await sync(c, selection, directory.self.serverId, undefined, undefined, snapshot,controls);
    // Re-split from this selection and rewrite the catalog (legacy entry if the CRD is old).
    const status = await inspect(c);
    await reconcile({ ...c, bundle: result }, status, await catalogDeps(paseo, c),
      { selection: { providers: selection.providers, mcps: selection.mcps, mcpUrls: selection.mcpUrls, includeMcpOAuthFile: selection.includeMcpOAuthFile, codexMode: c.providers.codexMode } },
    ).catch(() => undefined);
    return result;
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
