import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  useRpc,
  useSettings,
  type PluginScreenProps,
} from "@getpaseo/plugin/client";
import {
  ExternalLink,
  Loading,
  ScrollView,
  SettingsAction,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
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
type Environment = {
  message?: string;
  name: string;
  phase: string;
  hostStatus: string | null;
  serverId: string | null;
  cwd: string;
  error?: { message?: string } | null;
};
export function WorkspaceScreen({ theme, navigation }: PluginScreenProps) {
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
    fontSize: 15,
    lineHeight: 22,
  };
  return (
    <ScrollView
      contentContainerStyle={{ padding: 24, gap: 24, paddingBottom: 60 }}
    >
      <Text
        style={{
          color: theme.colors.foreground,
          fontSize: 22,
          fontWeight: "600",
        }}
      >
        Kubernetes Workspaces
      </Text>
      <Text style={text}>
        Connect a cluster, choose the main host’s credentials to reuse, and
        start isolated workspace daemons.
      </Text>
      {error && (
        <Text
          accessibilityRole="alert"
          style={{ ...text, color: theme.colors.statusDanger }}
        >
          {error}
        </Text>
      )}
      {settings.saveError && (
        <Text style={{ ...text, color: theme.colors.statusDanger }}>
          {settings.saveError}
        </Text>
      )}
      {settings.status !== "ready" && (
        <SettingsAction
          label="Settings could not be loaded"
          hint={
            settings.status === "invalid" || settings.status === "error"
              ? settings.error
              : undefined
          }
          actionLabel="Reload settings"
          onPress={() => void settings.reload()}
        />
      )}
      <SettingsSection title="Cluster connection">
        <SettingsInput
          key={
            "context" + (settings.status === "ready" ? settings.revision : "")
          }
          label="Kubernetes context"
          hint="Leave empty for kubectl’s current context or in-cluster service account."
          initialValue={draft.context}
          onChangeText={(v) => patch("context", v)}
          disabled={busy}
        />
        <SettingsInput
          key={
            "namespace" + (settings.status === "ready" ? settings.revision : "")
          }
          label="Namespace"
          initialValue={draft.namespace}
          onChangeText={(v) => patch("namespace", v)}
          disabled={busy}
        />
        <SettingsInput
          key={
            "cluster" + (settings.status === "ready" ? settings.revision : "")
          }
          label="Cluster ID"
          hint="A stable identifier for this cluster’s registrations."
          initialValue={draft.clusterId}
          onChangeText={(v) => patch("clusterId", v)}
          disabled={busy}
        />
        <SettingsInput
          key={"image" + (settings.status === "ready" ? settings.revision : "")}
          label="Workspace image"
          hint="Use the new bootstrap-enabled image built from images/workspace/."
          initialValue={draft.image}
          onChangeText={(v) => patch("image", v)}
          disabled={busy}
        />
        <SettingsInput
          key={"main" + (settings.status === "ready" ? settings.revision : "")}
          label="Main daemon connection (optional)"
          hint="An endpoint reachable from pods; enables reverse host registration."
          initialValue={draft.mainConnection}
          onChangeText={(v) => patch("mainConnection", v)}
          disabled={busy}
        />
        <SettingsSwitch
          label="Ephemeral workspace storage"
          hint="Use emptyDir: deleting or replacing the pod discards its data. Turn off to use a PVC until the environment is released."
          value={draft.ephemeral}
          onValueChange={(v) => patch("ephemeral", v)}
          disabled={busy}
        />
        <SettingsAction
          label="Save connection"
          actionLabel="Save"
          disabled={busy || settings.status !== "ready"}
          onPress={() =>
            void action(async () => {
              if (settings.status !== "ready") return;
              const config = settingsSchema.parse(draft);
              if (await settings.save(config, settings.revision)) {
                setSetup(null);
                toast.show("Connection saved.");
              } else
                throw new Error(
                  "Settings changed or could not be saved. Reload and try again.",
                );
            })
          }
        />
        <SettingsAction
          label="Check operator"
          hint="Uses Kubernetes API access; no operator Service URL is needed."
          actionLabel="Check connection"
          disabled={busy || !saved}
          onPress={() =>
            void action(async () => {
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
                    "Could not save the detected Kubernetes context. Reload settings and try again.",
                  );
                setDraft(next);
              }
              setSetup(result);
              if (result.operator === "ready") await refresh();
            })
          }
        />
        {setup && (
          <Text
            style={{
              ...text,
              color:
                setup.operator === "ready"
                  ? theme.colors.statusSuccess
                  : theme.colors.statusWarning,
            }}
          >
            {setup.message} {setup.context} / {setup.namespace}
          </Text>
        )}
      </SettingsSection>
      {setup?.operator !== "ready" && (
        <SettingsSection title="Install the operator">
          <Text style={text}>
            Build and push the operator and workspace images. Apply
            config/crd.yaml and config/operator.yaml after setting the operator
            image and namespace. Give the main daemon the Role in
            config/plugin-rbac.yaml and bind it to its ServiceAccount. The Role
            includes permission to create credential Secrets.
          </Text>
          <Text selectable style={{ ...text, fontFamily: "monospace" }}>
            kubectl apply -f config/crd.yaml{"\n"}kubectl apply -f
            config/operator.yaml{"\n"}kubectl apply -f config/plugin-rbac.yaml
          </Text>
          <ExternalLink href="https://github.com/lerenn/paseo-kubernetes-workspaces/blob/main/docs/setup.md">
            Read installation and bootstrap instructions
          </ExternalLink>
        </SettingsSection>
      )}
      <SettingsSection title="Provider and MCP credentials">
        <SettingsInput
          label="Local repository path (optional)"
          hint="A checkout on the main host. Its origin and .codex/config.toml will be used to prepare new pods."
          initialValue={repo}
          onChangeText={(v) => {
            setRepo(v);
            setInventory(null);
            setMcps([]);
            setTrust(false);
            setUrls({});
          }}
          disabled={busy}
        />
        <SettingsAction
          label="Find available credentials and MCPs"
          hint="Displays names and availability only. No credential values are sent to this screen."
          actionLabel="Discover"
          disabled={busy}
          onPress={() =>
            void action(async () => {
              const data = await discover({ repositoryPath: repo });
              setInventory(data);
              setProviders([]);
              setMcps([]);
              setOauth(false);
            })
          }
        />
        {inventory && (
          <>
            {inventory.providers.map((p) => (
              <SettingsSwitch
                key={p.id}
                label={p.label}
                hint={
                  p.available
                    ? "Available on the main host"
                    : "Unavailable; file-backed credentials or the named environment variable are required"
                }
                value={providers.includes(p.id)}
                onValueChange={(v) =>
                  setProviders(
                    toggle(
                      providers.filter(
                        (id) =>
                          !v ||
                          (p.id === "codex-login"
                            ? id !== "openai-key"
                            : p.id === "openai-key"
                              ? id !== "codex-login"
                              : true),
                      ),
                      p.id,
                      v,
                    ),
                  )
                }
                disabled={busy || !p.available}
              />
            ))}
            {inventory.mcps.length === 0 && (
              <Text style={text}>
                No MCP definitions found in Codex’s user or repository config.
              </Text>
            )}
            {inventory.mcps.map((m) => (
              <View key={m.name}>
                <SettingsSwitch
                  label={m.name}
                  hint={`${m.transport}${m.environment.length ? " · environment: " + m.environment.join(", ") : ""}${m.missing.length ? " · missing: " + m.missing.join(", ") : ""}${m.transport === "STDIO" ? " · its executable must be installed in the workspace image" : ""}`}
                  value={mcps.includes(m.name)}
                  onValueChange={(v) => setMcps(toggle(mcps, m.name, v))}
                  disabled={busy || m.missing.length > 0}
                />
                {m.transport === "HTTP" && mcps.includes(m.name) && (
                  <SettingsInput
                    label={`Pod URL for ${m.name}${m.needsUrl ? " (required)" : " (optional)"}`}
                    hint="Use a Service or endpoint reachable from pods. localhost on the main host cannot be reused."
                    initialValue={urls[m.name] ?? ""}
                    onChangeText={(v) =>
                      setUrls((prev) => ({ ...prev, [m.name]: v }))
                    }
                    disabled={busy}
                  />
                )}
              </View>
            ))}
            {inventory.oauthFile && (
              <SettingsSwitch
                label="Copy the entire file-backed MCP OAuth cache"
                hint="Explicitly includes all entries in Codex’s .credentials.json, not only selected MCPs. OS-keychain credentials cannot be exported."
                value={oauth}
                onValueChange={setOauth}
                disabled={busy || mcps.length === 0}
              />
            )}
            {inventory.repositoryUrl && (
              <>
                <Text selectable style={text}>
                  {inventory.repositoryUrl}
                </Text>
                <SettingsSwitch
                  label="Approve this repository for workspace pods"
                  hint="New pods clone this origin at /workspace/repository and trust its Codex project configuration. Only selected root-level MCP definitions are retained."
                  value={trust}
                  onValueChange={setTrust}
                  disabled={busy}
                />
                <SettingsInput
                  label="Branch, tag or commit (optional)"
                  hint="Defaults to the origin’s default branch. Private HTTPS repositories can use the selected GitHub token."
                  initialValue={revision}
                  onChangeText={setRevision}
                  disabled={busy}
                />
              </>
            )}
            <Text style={text}>
              Sync creates immutable credential snapshots in {draft.namespace}.
              New workspaces use the saved snapshot; existing pods keep their
              own writable copies. OAuth refresh is not coordinated across pods.
              Re-sync from the main host when credentials change.
            </Text>
            <SettingsAction
              label="Sync selected credentials and configuration"
              actionLabel="Sync to Kubernetes"
              disabled={
                busy ||
                !saved ||
                setup?.operator !== "ready" ||
                (!!inventory.repositoryUrl && !trust)
              }
              onPress={() =>
                void action(async () => {
                  const input = syncSelection.parse({
                    providers,
                    mcps,
                    repositoryPath: repo,
                    trustRepository: trust,
                    revision,
                    mcpUrls: Object.fromEntries(
                      Object.entries(urls).filter(([, v]) => v),
                    ),
                    includeMcpOAuthFile: oauth,
                  });
                  const profile = await sync(input);
                  if (settings.status !== "ready")
                    throw new Error(
                      "Reload settings to select the new snapshot.",
                    );
                  const next = { ...draft, bundle: profile };
                  if (!(await settings.save(next, settings.revision)))
                    throw new Error(
                      "Snapshot created, but settings changed. Re-sync to select it.",
                    );
                  setDraft(next);
                  toast.show("Credential snapshot saved for new workspaces.");
                })
              }
            />
          </>
        )}
        <Text style={text}>
          {currentBundle
            ? `Active snapshot: ${currentBundle.name}\nSynced ${currentBundle.syncedAt}\nProviders: ${currentBundle.providers.join(", ") || "none"} · MCPs: ${currentBundle.mcps.join(", ") || "none"}`
            : draft.bundle
              ? "The saved snapshot belongs to a different connection. Sync again for this connection."
              : "No credential snapshot selected yet."}
        </Text>
      </SettingsSection>
      <SettingsSection title="Workspace environments">
        <SettingsInput
          label="New environment name"
          hint="Lowercase letters, digits and hyphens, up to 50 characters."
          initialValue={name}
          onChangeText={setName}
          disabled={busy}
        />
        <SettingsAction
          label="Create environment"
          hint="Uses the active snapshot. The pod’s daemon appears as a connected host after bootstrap."
          actionLabel="Create"
          disabled={
            busy ||
            !saved ||
            setup?.operator !== "ready" ||
            !currentBundle ||
            !draft.image ||
            !name
          }
          onPress={() =>
            void action(async () => {
              setRows((await create({ name })) as Environment[]);
              toast.show("Environment requested.");
            })
          }
        />
        <SettingsAction
          label="Environment status"
          actionLabel="Refresh"
          disabled={busy || !saved || setup?.operator !== "ready"}
          onPress={() => void action(refresh)}
        />
        {rows.map((row) => (
          <View
            key={row.name}
            style={{
              borderTopWidth: 1,
              borderColor: theme.colors.border,
              paddingVertical: 12,
              gap: 8,
            }}
          >
            <Text style={{ ...text, color: theme.colors.foreground }}>
              {row.name} · {row.phase} · {row.hostStatus ?? "not registered"}
            </Text>
            {row.message && <Text style={text}>{row.message}</Text>}
            {row.serverId && (
              <Text selectable style={text}>
                serverId: {row.serverId} · directory: {row.cwd}
              </Text>
            )}
            {row.hostStatus === "online" && navigation && (
              <SettingsAction
                label="Open remote Paseo workspace"
                actionLabel="Open workspace"
                disabled={busy}
                onPress={() =>
                  void action(async () => {
                    const address = await open({ name: row.name });
                    navigation.openWorkspace(address);
                  })
                }
              />
            )}
            {row.error?.message && (
              <Text style={{ ...text, color: theme.colors.statusDanger }}>
                {row.error.message}
              </Text>
            )}
            {deleting === row.name ? (
              <>
                <Text style={{ ...text, color: theme.colors.statusWarning }}>
                  Delete {row.name}, including its pod and workspace storage?
                  Export results first.
                </Text>
                <SettingsAction
                  label="Confirm release"
                  actionLabel="Delete environment"
                  disabled={busy}
                  onPress={() =>
                    void action(async () => {
                      await release({ name: row.name });
                      setDeleting(null);
                      await refresh();
                    })
                  }
                />
                <SettingsAction
                  label="Keep this environment"
                  actionLabel="Cancel"
                  onPress={() => setDeleting(null)}
                />
              </>
            ) : (
              <SettingsAction
                label="Release workspace"
                actionLabel="Release"
                disabled={busy}
                onPress={() => setDeleting(row.name)}
              />
            )}
          </View>
        ))}
      </SettingsSection>
    </ScrollView>
  );
}
