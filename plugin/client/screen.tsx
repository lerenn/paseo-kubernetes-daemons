import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  Badge,
  Button,
  Card,
  Choice,
  Disclosure,
  Field,
} from "./components.js";
import {
  useRpc,
  useSettings,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import {
  ExternalLink,
  Loading,
  ScrollView,
  Icon,
  useToast,
} from "@getpaseo/plugin/client/ui";
import {
  workspaceSettings,
  settingsSchema,
  scopeOf,
  type Configuration,
} from "../shared/settings.js";
import {
  inspectSetup,
  providersStatus,
  providersSync,
  projectsList,
  projectsDiscover,
  projectsAdd,
  projectsUpdate,
  projectsApprove,
  projectsRemove,
  projectsSync,
  projectsCatalog,
  createEnvironment,
  listEnvironments,
  releaseEnvironment,
  openEnvironment,
} from "../shared/contracts.js";
import type { z } from "zod";
import { ProvidersTab, type ProvidersStatus } from "./providers-tab.js";
import { ProjectsTab, type ProjectRow, type ProjectsActions } from "./projects-tab.js";
import { applySynced, plural } from "./view.js";
const TABS = [
  { id: "overview", label: "Overview", icon: "Gauge" },
  { id: "cluster", label: "Cluster", icon: "Server" },
  { id: "providers", label: "Providers", icon: "KeyRound" },
  { id: "projects", label: "Projects", icon: "FolderGit2" },
  { id: "workspaces", label: "Workspaces", icon: "Boxes" },
] as const;
type TabId = (typeof TABS)[number]["id"];
type Environment = {
  message?: string;
  name: string;
  phase: string;
  hostStatus: string | null;
  serverId: string | null;
  cwd: string;
  error?: { message?: string } | null;
};
export function WorkspaceScreen({
  theme,
  layout,
  navigation,
}: PluginScreenProps) {
  const settings = useSettings(workspaceSettings);
  const toast = useToast();
  const inspect = useRpc(inspectSetup),
    providersStatusRpc = useRpc(providersStatus),
    providersSyncRpc = useRpc(providersSync),
    listProjects = useRpc(projectsList),
    discoverProject = useRpc(projectsDiscover),
    addProject = useRpc(projectsAdd),
    updateProject = useRpc(projectsUpdate),
    approveProject = useRpc(projectsApprove),
    removeProject = useRpc(projectsRemove),
    syncProject = useRpc(projectsSync),
    refreshCatalog = useRpc(projectsCatalog),
    create = useRpc(createEnvironment),
    list = useRpc(listEnvironments),
    release = useRpc(releaseEnvironment),
    open = useRpc(openEnvironment);
  const [draft, setDraft] = useState<Configuration>(settingsSchema.parse({}));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const loadProvidersRef = useRef<() => Promise<void>>(async () => {});
  const loadProjectsRef = useRef<() => Promise<void>>(async () => {});
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [setup, setSetup] = useState<z.output<
    typeof inspectSetup.output
  > | null>(null);
  const [providerStatus, setProviderStatus] =
    useState<ProvidersStatus | null>(null);
  const [projectRows, setProjectRows] = useState<ProjectRow[] | null>(null);
  const [name, setName] = useState(""),
    [rows, setRows] = useState<Environment[]>([]);
  const [tab, setTab] = useState<TabId>("overview");
  const [width, setWidth] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [deleting, setDeleting] = useState<string | null>(null);
  useEffect(() => {
    if (settings.status === "ready") setDraft(settings.values);
  }, [settings.status === "ready" ? settings.revision : ""]);
  useEffect(() => {
    if (settings.status !== "ready") return;
    let disposed = false;
    void inspect({})
      .then(async (result) => {
        if (disposed) return;
        setSetup(result);
        await applySplit(result).catch(() => {});
      })
      .catch(() => {
        if (!disposed) setSetup(null);
      });
    return () => {
      disposed = true;
    };
  }, [settings.status === "ready" ? settings.revision : ""]);
  useEffect(() => {
    if (settings.status !== "ready") return;
    if (tab === "providers") void loadProvidersRef.current();
    if (tab === "projects") void loadProjectsRef.current();
  }, [tab, settings.status === "ready" ? settings.revision : ""]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The operation failed.");
    } finally {
      setBusy(false);
    }
  }
  const saved =
    settings.status === "ready" &&
    JSON.stringify(draft) === JSON.stringify(settings.values);
  const currentBundle =
    draft.bundle?.scope === scopeOf(draft) ? draft.bundle : null;
  const patch = <K extends keyof Configuration>(
    key: K,
    value: Configuration[K],
  ) => setDraft((previous) => ({ ...previous, [key]: value }));
  const toggle = (values: string[], value: string, on: boolean) =>
    on ? [...new Set([...values, value])] : values.filter((v) => v !== value);
  const refresh = async () => {
    setRows((await list({})) as Environment[]);
  };
  // Polling only observes state and host registration. Credential export is always a human action.
  useEffect(() => {
    if (setup?.operator !== "ready" || !saved) return;
    let disposed = false;
    const timer = setInterval(() => {
      void list({})
        .then((result) => {
          if (!disposed) setRows(result as Environment[]);
        })
        .catch(() => {});
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [setup?.operator, saved]);
  if (settings.status === "loading") return <Loading />;
  const text = {
    color: theme.colors.foregroundMuted,
    fontSize: 14,
    lineHeight: 21,
  };
  const connected = setup?.operator === "ready";
  const wide = width > 860;
  const save = async () => {
    if (settings.status !== "ready") return;
    if (!(await settings.save(settingsSchema.parse(draft), settings.revision)))
      throw new Error("Settings changed. Reload and try again.");
    setSetup(null);
    toast.show("Connection saved.");
  };
  const check = async () => {
    const result = await inspect({});
    if (
      !draft.context &&
      result.context &&
      result.context !== "in-cluster / default" &&
      settings.status === "ready"
    ) {
      const next = { ...draft, context: result.context };
      if (!(await settings.save(next, settings.revision)))
        throw new Error(
          "Could not save the detected context. Reload and try again.",
        );
      setDraft(next);
    }
    setSetup(result);
    await applySplit(result);
    if (result.operator === "ready") await refresh();
  };
  // The silent split of the legacy profile ran server-side: store its result in the saved settings.
  async function applySplit(result: z.output<typeof inspectSetup.output>) {
    const current = settingsRef.current;
    if (!result.split || current.status !== "ready") return;
    const base = current.values;
    await persist({
      ...base,
      providers: { ...base.providers, lastSync: result.split.lastSync },
      projects: applySynced(base.projects, result.split.projects),
    });
  }
  const loadProviders = async () => {
    setProviderStatus(await providersStatusRpc({}));
  };
  const loadProjects = async () => {
    setProjectRows((await listProjects({})).projects);
  };
  loadProvidersRef.current = () => loadProviders().catch(() => {});
  loadProjectsRef.current = () => loadProjects().catch(() => {});
  // Saves settings, then waits for the new revision: a second save in the same action needs it.
  const persist = async (next: Configuration) => {
    const current = settingsRef.current;
    if (current.status !== "ready")
      throw new Error("Reload settings and try again.");
    const before = current.revision;
    if (!(await current.save(settingsSchema.parse(next), before)))
      throw new Error("Settings changed. Reload and try again.");
    setDraft(next);
    draftRef.current = next;
    for (let i = 0; i < 40; i++) {
      const now = settingsRef.current;
      if (now.status === "ready" && now.revision !== before) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const persistProjects = (projects: Configuration["projects"]) =>
    persist({ ...draftRef.current, projects });
  const reloadStatuses = async () => {
    await Promise.all([
      loadProviders().catch(() => {}),
      loadProjects().catch(() => {}),
    ]);
  };
  const syncProviders = async () => {
    const result = await providersSyncRpc({});
    const base = draftRef.current;
    await persist({
      ...base,
      providers: { ...base.providers, lastSync: result.lastSync },
      projects: applySynced(base.projects, result.projects),
    });
    const failed = result.projects.filter((p) => p.error).length;
    if (result.catalog.error) setError(`Providers synced, but the catalog was not updated: ${result.catalog.error}`);
    else if (failed) setError(`Providers synced. ${plural(failed, "project")} failed to sync: see the Projects tab.`);
    else toast.show("Providers synced.");
    await reloadStatuses();
  };
  const projectActions: ProjectsActions = {
    discover: (path) => discoverProject({ path }),
    addUrl: async (repository, revision) => {
      const r = await addProject({ repository, ...(revision ? { revision } : {}) });
      await persistProjects(r.projects);
      toast.show("Project added. Approve it to use it in workspaces.");
      await loadProjects();
    },
    addApproved: async (path, revision, mcps) => {
      const added = await addProject({ path, ...(revision ? { revision } : {}) });
      await persistProjects(added.projects);
      const r = await approveProject({ id: added.project.id, approved: true, projectMcps: mcps });
      await persistProjects(r.projects);
      toast.show("Project approved. Sync it to use it in workspaces.");
      await loadProjects();
    },
    approve: async (id, mcps) => {
      const r = await approveProject({ id, approved: true, ...(mcps ? { projectMcps: mcps } : {}) });
      await persistProjects(r.projects);
      toast.show("Project approved. Sync it to use it in workspaces.");
      await loadProjects();
    },
    unapprove: async (id) => {
      const r = await approveProject({ id, approved: false });
      await persistProjects(r.projects);
      if (connected) await refreshCatalog({});
      await loadProjects();
    },
    update: async (input) => {
      const r = await updateProject(input);
      await persistProjects(r.projects);
      if (connected) await refreshCatalog({});
      toast.show("Project saved.");
      await loadProjects();
    },
    sync: async (id) => {
      const r = await syncProject({ id });
      const base = draftRef.current;
      await persistProjects(applySynced(base.projects, [r.project]));
      if (r.catalog.error) setError(`Project synced, but the catalog was not updated: ${r.catalog.error}`);
      else toast.show("Project synced.");
      await loadProjects();
    },
    remove: async (id) => {
      const r = await removeProject({ id });
      await persistProjects(r.projects);
      if (connected) await refreshCatalog({});
      toast.show("Project removed. Running workspaces were not changed.");
      await loadProjects();
    },
    refresh: loadProjects,
  };
  const providerSynced = !!draft.providers.lastSync || !!currentBundle;
  const projectsSynced = draft.projects.filter((p) => p.synced).length;
  const canCreate =
    connected && saved && !!draft.image && !!name && !busy;
  const pad = layout.compact ? 16 : 28;
  return (
    <View
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      <View
        style={{
          paddingHorizontal: pad,
          paddingTop: pad,
          gap: 14,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              backgroundColor: theme.colors.accent,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon
              name="Boxes"
              size={26}
              color={theme.colors.accentForeground}
            />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              style={{
                color: theme.colors.foreground,
                fontSize: layout.compact ? 20 : 24,
                fontWeight: "700",
              }}
            >
              Kubernetes Workspaces
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
              Run Paseo workspaces as pods on your Kubernetes cluster.
            </Text>
          </View>
          <ExternalLink href="https://github.com/lerenn/paseo-kubernetes-workspaces/blob/main/docs/setup.md">
            Setup guide
          </ExternalLink>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 4 }}
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <Pressable
                key={t.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={t.label}
                onPress={() => setTab(t.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 7,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderBottomWidth: 2,
                  borderBottomColor: active
                    ? theme.colors.accent
                    : "transparent",
                }}
              >
                <Icon
                  name={t.icon}
                  size={15}
                  color={
                    active ? theme.colors.accent : theme.colors.foregroundMuted
                  }
                />
                <Text
                  style={{
                    color: active
                      ? theme.colors.foreground
                      : theme.colors.foregroundMuted,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          padding: pad,
          paddingBottom: pad * 2,
        }}
      >
        <View
          style={{
            width: "100%",
            maxWidth: 1100,
            minWidth: 0,
            marginHorizontal: "auto",
            gap: 24,
          }}
        >
          {(error || settings.saveError) && (
            <View
              accessibilityRole="alert"
              style={{
                padding: 14,
                borderWidth: 1,
                borderColor: theme.colors.statusDanger,
                borderRadius: 10,
                backgroundColor: theme.colors.surface1,
              }}
            >
              <Text style={{ ...text, color: theme.colors.statusDanger }}>
                {error ?? settings.saveError}
              </Text>
            </View>
          )}
          {settings.status !== "ready" && (
            <View style={{ gap: 12 }}>
              <Text style={text}>
                {settings.status === "invalid" || settings.status === "error"
                  ? settings.error
                  : "Settings are unavailable."}
              </Text>
              <Button
                theme={theme}
                label="Reload settings"
                icon="RefreshCw"
                onPress={() => void settings.reload()}
              />
            </View>
          )}
          {tab === "overview" && (
            <Card
              theme={theme}
              title="Overview"
              icon="Gauge"
              description="Where your setup stands."
            >
              {(
                [
                  {
                    tab: "cluster",
                    icon: "Server",
                    label: "Cluster",
                    done: connected,
                    value: connected
                      ? `Connected · ${draft.context || setup?.context || "current context"} · ${draft.namespace}`
                      : draft.image
                        ? "Settings saved, not connected"
                        : "Not configured",
                    detail: draft.gatewayEndpoint
                      ? `Public gateway endpoint: ${draft.gatewayEndpoint}`
                      : "Public gateway endpoint: not set (in-cluster Service)",
                  },
                  {
                    tab: "providers",
                    icon: "KeyRound",
                    label: "Providers",
                    done: providerSynced,
                    value: draft.providers.lastSync
                      ? `Last synced ${new Date(draft.providers.lastSync.at).toLocaleString()}`
                      : currentBundle
                        ? "Legacy credentials synced; sync providers to upgrade"
                        : "Not synced",
                    detail: `${plural(draft.providers.selected.length, "provider")} and ${plural(draft.providers.mcps.length, "MCP server")} selected`,
                  },
                  {
                    tab: "projects",
                    icon: "FolderGit2",
                    label: "Projects",
                    done: projectsSynced > 0,
                    value: draft.projects.length
                      ? `${projectsSynced} of ${plural(draft.projects.length, "project")} synced`
                      : "No projects yet",
                    detail: draft.projects.some((p) => !p.trusted)
                      ? "Some projects still need approval."
                      : "",
                  },
                  {
                    tab: "workspaces",
                    icon: "Boxes",
                    label: "Workspaces",
                    done: rows.length > 0,
                    value: `${rows.length} workspace${rows.length === 1 ? "" : "s"}`,
                    detail: rows.length
                      ? `${rows.filter((r) => r.hostStatus === "online").length} online`
                      : "",
                  },
                ] as const
              ).map((item) => (
                <View
                  key={item.tab}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                    paddingVertical: 6,
                  }}
                >
                  <Icon
                    name={item.done ? "CircleCheck" : "Circle"}
                    size={18}
                    color={
                      item.done
                        ? theme.colors.statusSuccess
                        : theme.colors.foregroundMuted
                    }
                  />
                  <View style={{ flex: 1, minWidth: 180, gap: 2 }}>
                    <Text
                      style={{
                        ...text,
                        color: theme.colors.foreground,
                        fontWeight: "600",
                      }}
                    >
                      {item.label}
                    </Text>
                    <Text style={text}>{item.value}</Text>
                    {item.detail ? (
                      <Text style={text}>{item.detail}</Text>
                    ) : null}
                  </View>
                  <Button
                    theme={theme}
                    label={`Go to ${item.label}`}
                    icon={item.icon}
                    onPress={() => setTab(item.tab)}
                  />
                </View>
              ))}
            </Card>
          )}
          {tab === "cluster" && (
            <Card
              theme={theme}
              title="Cluster"
              icon="Server"
              description="The home for your workspace pods."
              badge={
                <Badge
                  theme={theme}
                  label={
                    connected
                      ? "Connected"
                      : setup?.operator === "missing"
                        ? "Setup needed"
                        : "Not connected"
                  }
                  tone={connected ? "success" : "muted"}
                />
              }
            >
              <Field
                theme={theme}
                label="Workspace image"
                placeholder="registry.example.com/paseo-workspace:latest"
                value={draft.image}
                onChange={(v) => patch("image", v)}
                disabled={busy}
              />
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <Icon
                  name="Network"
                  size={15}
                  color={theme.colors.foregroundMuted}
                />
                <Text style={text}>
                  {draft.context ||
                    setup?.context ||
                    "Current Kubernetes context"}{" "}
                  · {draft.namespace}
                </Text>
              </View>
              {setup && !connected && (
                <View
                  style={{
                    backgroundColor: theme.colors.surface2,
                    borderRadius: 8,
                    padding: 12,
                    gap: 5,
                  }}
                >
                  <Text
                    style={{
                      ...text,
                      color: theme.colors.foreground,
                      fontWeight: "500",
                    }}
                  >
                    {setup.operator === "missing"
                      ? "Install the operator to connect"
                      : "Connection needs attention"}
                  </Text>
                  <Text style={text}>
                    {setup.operator === "missing"
                      ? "A one-time installation prepares your cluster for workspace pods."
                      : setup.message}
                  </Text>
                </View>
              )}
              <Disclosure
                theme={theme}
                label="Advanced cluster settings"
                summary="Connection, namespace & storage"
              >
                <Field
                  theme={theme}
                  label="Kubernetes context"
                  value={draft.context}
                  onChange={(v) => patch("context", v)}
                  placeholder="Use current context"
                  hint="Leave empty to use the current context or in-cluster access."
                  disabled={busy}
                />
                <Field
                  theme={theme}
                  label="Namespace"
                  value={draft.namespace}
                  onChange={(v) => patch("namespace", v)}
                  disabled={busy}
                />
                <Field
                  theme={theme}
                  label="Cluster ID"
                  value={draft.clusterId}
                  onChange={(v) => patch("clusterId", v)}
                  hint="A stable name to distinguish this cluster."
                  disabled={busy}
                />
                <Field
                  theme={theme}
                  label="Main daemon endpoint"
                  value={draft.mainConnection}
                  onChange={(v) => patch("mainConnection", v)}
                  placeholder="Optional"
                  hint="Enable communication initiated by pod agents back to the main daemon."
                  disabled={busy}
                />
                <Field
                  theme={theme}
                  label="Public gateway endpoint"
                  value={draft.gatewayEndpoint}
                  onChange={(v) => patch("gatewayEndpoint", v)}
                  placeholder="Optional, e.g. workspaces.paseo.example.net"
                  hint="TLS host[:port] of the operator's Kubernetes host, for apps outside the cluster. Empty uses the in-cluster Service."
                  disabled={busy}
                />
                <Field
                  theme={theme}
                  label="Host name"
                  value={draft.gatewayHostName}
                  onChange={(v) => patch("gatewayHostName", v)}
                  placeholder="Optional, e.g. Anyshift Lab · Kubernetes"
                  hint="Shown in the host picker. Empty uses '<daemon name> · Kubernetes'."
                  disabled={busy}
                />
                <Choice
                  theme={theme}
                  label="Enable Docker"
                  description="Run a dedicated Docker engine in each new workspace. Requires privileged containers in the workspace namespace."
                  checked={draft.docker}
                  onChange={(v) => patch("docker", v)}
                  disabled={busy}
                />
                <Choice
                  theme={theme}
                  label="Ephemeral storage"
                  description="Discard files when the pod is deleted or replaced. Turn off to keep a persistent volume until release."
                  checked={draft.ephemeral}
                  onChange={(v) => patch("ephemeral", v)}
                  disabled={busy}
                />
              </Disclosure>
              {!connected && (
                <Disclosure
                  theme={theme}
                  title="Installation instructions"
                  summary="Commands and operator requirements"
                >
                  <Text style={text}>
                    Build and push the operator and workspace images, update the
                    image in the deployment manifest, then apply:
                  </Text>
                  <View
                    style={{
                      padding: 12,
                      borderRadius: 8,
                      backgroundColor: theme.colors.surface0,
                    }}
                  >
                    <Text
                      selectable
                      style={{ ...text, fontFamily: "monospace" }}
                    >
                      kubectl apply -f config/crd.yaml{"\n"}kubectl apply -f
                      config/operator.yaml{"\n"}kubectl apply -f
                      config/plugin-rbac.yaml
                    </Text>
                  </View>
                  <Text style={text}>
                    Use your chosen namespace and bind the plugin Role to the
                    main daemon’s ServiceAccount.
                  </Text>
                  <ExternalLink href="https://github.com/lerenn/paseo-kubernetes-workspaces/blob/main/docs/setup.md">
                    Full installation guide
                  </ExternalLink>
                </Disclosure>
              )}
              <View
                style={{
                  flexDirection: "row",
                  gap: 10,
                  flexWrap: "wrap",
                  marginTop: "auto",
                }}
              >
                <Button
                  theme={theme}
                  label={busy ? "Working…" : "Save changes"}
                  primary
                  disabled={busy || settings.status !== "ready" || saved}
                  onPress={() => void action(save)}
                />
                <Button
                  theme={theme}
                  label="Check connection"
                  icon="RefreshCw"
                  disabled={busy || !saved}
                  onPress={() => void action(check)}
                />
              </View>
              {!saved && <Text style={text}>You have unsaved changes.</Text>}
            </Card>
          )}
          {tab === "providers" && (
            <ProvidersTab
              theme={theme}
              text={text}
              value={draft.providers}
              status={providerStatus}
              namespace={draft.namespace}
              busy={busy}
              saved={saved}
              connected={connected}
              onChange={(next) => patch("providers", next)}
              onFind={() => void action(loadProviders)}
              onSave={() => void action(save)}
              onSync={() => void action(syncProviders)}
            />
          )}
          {tab === "projects" && (
            <ProjectsTab
              theme={theme}
              text={text}
              projects={projectRows}
              selectedProviders={draft.providers.selected}
              busy={busy}
              saved={saved}
              connected={connected}
              actions={projectActions}
            />
          )}
          {tab === "workspaces" && (
            <Card
              theme={theme}
              title="Workspaces"
              icon="Boxes"
              description="An isolated daemon for every project."
              badge={
                <Badge
                  theme={theme}
                  label={`${rows.length} workspace${rows.length === 1 ? "" : "s"}`}
                />
              }
            >
              <View
                style={{
                  flexDirection: wide ? "row" : "column",
                  gap: 12,
                  alignItems: wide ? "flex-end" : "stretch",
                }}
              >
                <View style={{ flex: 1 }}>
                  <Field
                    theme={theme}
                    label="Workspace name"
                    placeholder="my-next-project"
                    value={name}
                    onChange={setName}
                    disabled={busy}
                  />
                </View>
                <Button
                  theme={theme}
                  label="Create workspace"
                  icon="Plus"
                  primary
                  disabled={!canCreate}
                  onPress={() =>
                    void action(async () => {
                      setRows((await create({ name })) as Environment[]);
                      toast.show("Workspace requested.");
                    })
                  }
                />
                <Button
                  theme={theme}
                  label="Refresh"
                  icon="RefreshCw"
                  disabled={busy || !saved || !connected}
                  onPress={() => void action(refresh)}
                />
              </View>
              {rows.length === 0 ? (
                <View
                  style={{
                    alignItems: "center",
                    gap: 9,
                    paddingVertical: 24,
                    borderWidth: 1,
                    borderStyle: "dashed",
                    borderColor: theme.colors.border,
                    borderRadius: 10,
                  }}
                >
                  <Icon
                    name="Box"
                    size={28}
                    color={theme.colors.foregroundMuted}
                  />
                  <Text
                    style={{
                      fontSize: 15,
                      fontWeight: "500",
                      color: theme.colors.foreground,
                    }}
                  >
                    Room for your next project
                  </Text>
                  <Text
                    style={{
                      ...text,
                      textAlign: "center",
                      paddingHorizontal: 16,
                    }}
                  >
                    {connected && providerSynced
                      ? "Create a workspace to start working in its own pod."
                      : "Connect your cluster, sync providers and add a project to get started."}
                  </Text>
                </View>
              ) : (
                rows.map((row) => (
                  <View
                    key={row.name}
                    style={{
                      borderTopWidth: 1,
                      borderColor: theme.colors.border,
                      paddingTop: 16,
                      gap: 12,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 12,
                        flexWrap: "wrap",
                      }}
                    >
                      <View style={{ flex: 1, minWidth: 160, gap: 5 }}>
                        <Text
                          style={{
                            fontSize: 16,
                            fontWeight: "600",
                            color: theme.colors.foreground,
                          }}
                        >
                          {row.name}
                        </Text>
                        <Text style={text}>
                          {row.hostStatus === "online"
                            ? "Ready to work"
                            : (row.hostStatus ?? row.phase)}
                        </Text>
                      </View>
                      <Badge
                        theme={theme}
                        label={
                          row.hostStatus === "online" ? "Online" : row.phase
                        }
                        tone={
                          row.hostStatus === "online"
                            ? "success"
                            : row.phase === "Failed"
                              ? "warning"
                              : "muted"
                        }
                      />
                      {row.hostStatus === "online" && navigation && (
                        <Button
                          theme={theme}
                          label="Open workspace"
                          primary
                          disabled={busy}
                          onPress={() =>
                            void action(async () => {
                              navigation.openWorkspace(
                                await open({ name: row.name }),
                              );
                            })
                          }
                        />
                      )}
                      <Button
                        theme={theme}
                        label="Release"
                        disabled={busy}
                        onPress={() => setDeleting(row.name)}
                      />
                    </View>
                    {row.message && <Text style={text}>{row.message}</Text>}
                    {row.error?.message && (
                      <Text
                        style={{ ...text, color: theme.colors.statusDanger }}
                      >
                        {row.error.message}
                      </Text>
                    )}
                    {deleting === row.name && (
                      <View
                        style={{
                          backgroundColor: theme.colors.surface2,
                          padding: 14,
                          borderRadius: 8,
                          gap: 12,
                        }}
                      >
                        <Text style={text}>
                          Delete {row.name} and its workspace storage? Export
                          your results first.
                        </Text>
                        <View
                          style={{
                            flexDirection: "row",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <Button
                            theme={theme}
                            label="Delete workspace"
                            danger
                            disabled={busy}
                            onPress={() =>
                              void action(async () => {
                                await release({ name: row.name });
                                setDeleting(null);
                                await refresh();
                              })
                            }
                          />
                          <Button
                            theme={theme}
                            label="Cancel"
                            onPress={() => setDeleting(null)}
                          />
                        </View>
                      </View>
                    )}
                    <Disclosure theme={theme} title="Connection details">
                      <Text selectable style={text}>
                        Server: {row.serverId ?? "Not registered"}
                        {"\n"}Directory: {row.cwd}
                      </Text>
                    </Disclosure>
                  </View>
                ))
              )}
            </Card>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
