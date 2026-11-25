import { useEffect, useState } from "react";
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
  discoverSources,
  syncCredentials,
  syncSelection,
  createEnvironment,
  listEnvironments,
  releaseEnvironment,
  openEnvironment,
} from "../shared/contracts.js";
import type { z } from "zod";
type Inventory = z.output<typeof discoverSources.output>;
const TABS = [
  { id: "overview", label: "Overview", icon: "Gauge" },
  { id: "cluster", label: "Cluster", icon: "Server" },
  { id: "credentials", label: "Credentials", icon: "KeyRound" },
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
    discover = useRpc(discoverSources),
    sync = useRpc(syncCredentials),
    create = useRpc(createEnvironment),
    list = useRpc(listEnvironments),
    release = useRpc(releaseEnvironment),
    open = useRpc(openEnvironment);
  const [draft, setDraft] = useState<Configuration>(settingsSchema.parse({}));
  const [setup, setSetup] = useState<z.output<
    typeof inspectSetup.output
  > | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [repo, setRepo] = useState("");
  const [revision, setRevision] = useState("");
  const [providers, setProviders] = useState<string[]>([]),
    [mcps, setMcps] = useState<string[]>([]),
    [urls, setUrls] = useState<Record<string, string>>({});
  const [trust, setTrust] = useState(false),
    [oauth, setOauth] = useState(false),
    [name, setName] = useState(""),
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
      .then((result) => {
        if (!disposed) setSetup(result);
      })
      .catch(() => {
        if (!disposed) setSetup(null);
      });
    return () => {
      disposed = true;
    };
  }, [settings.status === "ready" ? settings.revision : ""]);
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
    if (result.operator === "ready") await refresh();
  };
  const find = async () => {
    setInventory(await discover({ repositoryPath: repo }));
    setProviders([]);
    setMcps([]);
    setOauth(false);
  };
  const syncSelected = async () => {
    const input = syncSelection.parse({
      providers,
      mcps,
      repositoryPath: repo,
      trustRepository: trust,
      revision,
      mcpUrls: Object.fromEntries(Object.entries(urls).filter(([, v]) => v)),
      includeMcpOAuthFile: oauth,
    });
    const profile = await sync(input);
    if (settings.status !== "ready")
      throw new Error("Reload settings to select the new snapshot.");
    const next = { ...draft, bundle: profile };
    if (!(await settings.save(next, settings.revision)))
      throw new Error(
        "Snapshot created, but settings changed. Re-sync to select it.",
      );
    setDraft(next);
    toast.show("Credentials ready for new workspaces.");
  };
  const chooseProvider = (id: string, selected: boolean) =>
    setProviders(
      toggle(
        providers.filter(
          (p) =>
            !selected ||
            (id === "codex-login"
              ? p !== "openai-key"
              : id === "openai-key"
                ? p !== "codex-login"
                : true),
        ),
        id,
        selected,
      ),
    );
  const providerLabel = (id: string, label: string) =>
    ({
      "codex-login": "Codex subscription",
      "openai-key": "OpenAI API key",
      "anthropic-key": "Anthropic API key",
      "gemini-key": "Gemini API key",
      "github-token": "GitHub repository access",
    })[id] ?? label;
  const canCreate =
    connected && saved && !!currentBundle && !!draft.image && !!name && !busy;
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
                    tab: "credentials",
                    icon: "KeyRound",
                    label: "Credentials",
                    done: !!currentBundle,
                    value: currentBundle
                      ? `Last synced ${new Date(currentBundle.syncedAt).toLocaleString()}`
                      : "Not synced",
                    detail: currentBundle
                      ? `${currentBundle.providers.length} provider${currentBundle.providers.length === 1 ? "" : "s"}, ${currentBundle.mcps.length} MCP server${currentBundle.mcps.length === 1 ? "" : "s"}`
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
                  placeholder="Optional, e.g. Anyshift Lab (Kubernetes)"
                  hint="Shown in the host picker. Empty uses '<daemon name> (Kubernetes)'."
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
          {tab === "credentials" && (
            <Card
              theme={theme}
              title="Credentials"
              icon="KeyRound"
              description="Reuse the accounts you already have."
              badge={
                <Badge
                  theme={theme}
                  label={currentBundle ? "Synced" : "Not synced"}
                  tone={currentBundle ? "success" : "muted"}
                />
              }
            >
              <Field
                theme={theme}
                label="Repository"
                value={repo}
                onChange={(v) => {
                  setRepo(v);
                  setInventory(null);
                  setMcps([]);
                  setTrust(false);
                  setUrls({});
                }}
                placeholder="/path/to/your/repository (optional)"
                hint="Optional checkout on the main daemon. Leave empty to discover provider credentials and MCPs configured on this host."
                disabled={busy}
              />
              {currentBundle && !inventory && (
                <View
                  style={{
                    padding: 12,
                    borderRadius: 8,
                    backgroundColor: theme.colors.surface2,
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
                    Credentials ready for new workspaces
                  </Text>
                  <Text style={text}>
                    {currentBundle.providers
                      .map((p) => providerLabel(p, p))
                      .join(", ") || "Configuration only"}
                    {currentBundle.mcps.length
                      ? ` · ${currentBundle.mcps.length} MCP server${currentBundle.mcps.length === 1 ? "" : "s"}`
                      : ""}
                  </Text>
                </View>
              )}
              {!currentBundle && !inventory && (
                <Text style={text}>
                  {draft.bundle
                    ? "Your saved credentials belong to another connection. Sync them to this cluster."
                    : "Choose the providers and MCP servers you want to bring into your workspaces."}
                </Text>
              )}
              <View style={{ alignSelf: "flex-start" }}>
                <Button
                  theme={theme}
                  label={inventory ? "Refresh discovery" : "Find credentials"}
                  icon="Search"
                  primary={!inventory && !currentBundle}
                  disabled={busy}
                  onPress={() => void action(find)}
                />
              </View>
              {inventory && (
                <View style={{ gap: 12 }}>
                  <Text
                    style={{
                      ...text,
                      fontWeight: "600",
                      color: theme.colors.foreground,
                    }}
                  >
                    Providers
                  </Text>
                  {inventory.providers
                    .filter((p) => p.available)
                    .map((p) => (
                      <Choice
                        key={p.id}
                        theme={theme}
                        label={providerLabel(p.id, p.label)}
                        description={
                          p.id === "codex-login"
                            ? "Use your existing subscription."
                            : p.id === "github-token"
                              ? "For private GitHub repositories."
                              : p.id === "anthropic-key" ||
                                  p.id === "gemini-key"
                                ? "Requires this provider in your workspace image."
                                : undefined
                        }
                        checked={providers.includes(p.id)}
                        onChange={(v) => chooseProvider(p.id, v)}
                        disabled={busy}
                      />
                    ))}
                  {!inventory.providers.some((p) => p.available) && (
                    <Text style={text}>
                      No reusable provider credentials found on the main host.
                    </Text>
                  )}
                  {inventory.mcps.length > 0 && (
                    <View
                      style={{
                        gap: 4,
                        borderTopWidth: 1,
                        borderColor: theme.colors.border,
                        paddingTop: 14,
                      }}
                    >
                      <Text
                        style={{
                          ...text,
                          fontWeight: "600",
                          color: theme.colors.foreground,
                        }}
                      >
                        MCP servers
                      </Text>
                      {inventory.mcps.map((m) => (
                        <View key={m.name}>
                          <Choice
                            theme={theme}
                            label={m.name}
                            description={
                              m.missing.length
                                ? `Missing: ${m.missing.join(", ")}`
                                : m.transport === "STDIO"
                                  ? "Requires its executable in the workspace image"
                                  : undefined
                            }
                            checked={mcps.includes(m.name)}
                            onChange={(v) => setMcps(toggle(mcps, m.name, v))}
                            disabled={busy || m.missing.length > 0}
                          />
                          {m.transport === "HTTP" &&
                            mcps.includes(m.name) &&
                            m.needsUrl && (
                              <Field
                                theme={theme}
                                label={`Reachable URL for ${m.name}`}
                                value={urls[m.name] ?? ""}
                                onChange={(v) =>
                                  setUrls((prev) => ({ ...prev, [m.name]: v }))
                                }
                                hint="Replace localhost with an endpoint reachable from pods."
                                disabled={busy}
                              />
                            )}
                        </View>
                      ))}
                    </View>
                  )}
                  {inventory.repositoryUrl && (
                    <View
                      style={{
                        borderTopWidth: 1,
                        borderColor: theme.colors.border,
                        paddingTop: 10,
                      }}
                    >
                      <Text selectable style={text}>
                        {inventory.repositoryUrl}
                      </Text>
                      <Choice
                        theme={theme}
                        label="Trust this repository in new workspaces"
                        description="Approve its project configuration once for future pods."
                        checked={trust}
                        onChange={setTrust}
                        disabled={busy}
                      />
                    </View>
                  )}
                </View>
              )}
              <Disclosure
                theme={theme}
                label="Advanced credential settings"
                summary="OAuth, revisions & sync details"
              >
                {inventory?.repositoryUrl && (
                  <Field
                    theme={theme}
                    label="Branch, tag or commit"
                    value={revision}
                    onChange={setRevision}
                    placeholder="Default branch"
                    disabled={busy}
                  />
                )}
                {inventory?.mcps
                  .filter(
                    (m) =>
                      m.transport === "HTTP" &&
                      mcps.includes(m.name) &&
                      !m.needsUrl,
                  )
                  .map((m) => (
                    <Field
                      key={m.name}
                      theme={theme}
                      label={`Override URL for ${m.name}`}
                      value={urls[m.name] ?? ""}
                      onChange={(v) =>
                        setUrls((prev) => ({ ...prev, [m.name]: v }))
                      }
                      placeholder="Keep configured URL"
                      disabled={busy}
                    />
                  ))}
                {inventory?.oauthFile && (
                  <Choice
                    theme={theme}
                    label="Include the entire MCP OAuth cache"
                    description="Copies all file-backed OAuth entries, including unselected servers. OS-keychain credentials are not exported."
                    checked={oauth}
                    onChange={setOauth}
                    disabled={busy || !mcps.length}
                  />
                )}
                {inventory?.providers
                  .filter((p) => !p.available)
                  .map((p) => (
                    <Choice
                      key={p.id}
                      theme={theme}
                      label={providerLabel(p.id, p.label)}
                      description="Not available on the main daemon."
                      checked={false}
                      onChange={() => {}}
                      disabled
                    />
                  ))}
                <Text style={text}>
                  Only selected credentials are exported to Kubernetes Secrets
                  in {draft.namespace}. The panel never receives their values.
                </Text>
                {currentBundle && !currentBundle.gatewayReady && (
                  <Text style={text}>
                    Sync again to include provider and MCP selections in this
                    profile.
                  </Text>
                )}
                <Text style={text}>
                  Credentials are snapshots. Existing pods keep their writable
                  copies. Re-sync after credentials change; OAuth refresh is not
                  coordinated between pods.
                </Text>
                {currentBundle && (
                  <View style={{ gap: 6 }}>
                    <Text style={text}>
                      Last synced:{" "}
                      {new Date(currentBundle.syncedAt).toLocaleString()}
                    </Text>
                    <Text
                      selectable
                      style={{ ...text, fontFamily: "monospace" }}
                    >
                      {currentBundle.name}
                    </Text>
                  </View>
                )}
              </Disclosure>
              {inventory && (
                <View style={{ gap: 9 }}>
                  <Button
                    theme={theme}
                    label={`Sync selection${providers.length + mcps.length ? ` (${providers.length + mcps.length})` : ""}`}
                    icon="CloudUpload"
                    primary
                    disabled={
                      busy ||
                      !saved ||
                      !connected ||
                      (!!inventory.repositoryUrl && !trust)
                    }
                    onPress={() => void action(syncSelected)}
                  />
                  <Text style={text}>
                    {!connected
                      ? "Connect your cluster to sync this selection."
                      : !saved
                        ? "Save your connection changes before syncing."
                        : "Only your selection will be shared with new workspaces."}
                  </Text>
                </View>
              )}
            </Card>
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
                    {connected && currentBundle
                      ? "Create a workspace to start working in its own pod."
                      : "Connect your cluster and sync credentials to get started."}
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
