import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { Badge, Button, Card, Choice, Disclosure, Field, type Theme } from "./components.js";
import type { providersStatus } from "../shared/contracts.js";
import type { Configuration } from "../shared/settings.js";
import { plural, providerLabel, rowStateBadge } from "./view.js";

export type ProvidersStatus = z.output<typeof providersStatus.output>;
type ProvidersConfig = Configuration["providers"];

const HINTS: Record<string, string> = {
  "codex-login": "Use your existing subscription.",
  "github-token": "For private GitHub repositories (exported as GITHUB_TOKEN).",
  "anthropic-key": "Requires this provider in your workspace image.",
  "claude-login": "Reuse your Claude subscription login (the access token only by default).",
  "claude-token": "Recommended for pods: a one-year token from `claude setup-token`, exported as CLAUDE_CODE_OAUTH_TOKEN on the main daemon.",
  "gemini-key": "Requires this provider in your workspace image.",
};

export function ProvidersTab(props: {
  theme: Theme;
  text: object;
  value: ProvidersConfig;
  status: ProvidersStatus | null;
  namespace: string;
  busy: boolean;
  saved: boolean;
  connected: boolean;
  onChange: (next: ProvidersConfig) => void;
  onFind: () => void;
  onSave: () => void;
  onSync: () => void;
}) {
  const { theme, text, value, status, busy, saved, connected } = props;
  const [query, setQuery] = useState("");
  const set = (patch: Partial<ProvidersConfig>) => props.onChange({ ...value, ...patch });
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...new Set([...list, id])] : list.filter((x) => x !== id);
  const chooseProvider = (id: string, on: boolean) => {
    let selected = toggle(value.selected, id, on) as ProvidersConfig["selected"];
    // The Codex login and an OpenAI API key are mutually exclusive.
    if (on && id === "codex-login") selected = selected.filter((p) => p !== "openai-key");
    if (on && id === "openai-key") selected = selected.filter((p) => p !== "codex-login");
    set({ selected });
  };
  const lastSync = value.lastSync;
  const q = query.trim().toLowerCase();
  const visible = (status?.providers ?? []).filter(
    (p) => !q || `${p.label} ${p.providerId} ${p.base}`.toLowerCase().includes(q),
  );
  const codex = value.selected.includes("codex-login");
  const claudeLogin = value.selected.includes("claude-login");
  const claudeWarning = () => (
    <View style={{ paddingLeft: 30, gap: 4 }}>
      <Text style={{ ...(text as object), color: theme.colors.statusWarning }}>
        {value.claudeMode === "access-only"
          ? "Access-only: pods get the short-lived access token without the refresh token. Claude in a pod stops working when it expires (about eight hours); sync providers again to renew it, or use a long-lived token from `claude setup-token` instead."
          : "Refreshing: every pod gets the refresh token. Pods refresh independently and can invalidate each other's login (and yours)."}
      </Text>
    </View>
  );
  const heading = {
    ...(text as object),
    fontWeight: "600" as const,
    color: theme.colors.foreground,
  };
  const row = (
    key: string,
    label: string,
    opts: {
      found: boolean;
      selected: boolean;
      state: string;
      description?: string;
      onChange: (on: boolean) => void;
      extra?: ReactNode;
    },
  ) => {
    const badge = rowStateBadge(opts.state);
    return (
      <View key={key} style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <View style={{ flex: 1, minWidth: 200 }}>
            <Choice
              theme={theme}
              label={label}
              description={opts.found ? opts.description : "Not found on the main daemon. Log in on the main host, then Find providers."}
              checked={opts.selected}
              onChange={opts.onChange}
              disabled={busy || (!opts.found && !opts.selected)}
            />
          </View>
          <Badge theme={theme} label={opts.found ? "Found" : "Not found"} tone={opts.found ? "success" : "muted"} />
          {opts.selected && <Badge theme={theme} label="Selected" tone="success" />}
          {badge && <Badge theme={theme} label={badge.label} tone={badge.tone} />}
        </View>
        {opts.extra}
      </View>
    );
  };
  return (
    <Card
      theme={theme}
      title="Providers"
      icon="KeyRound"
      description="Accounts and MCP servers shared by every project."
      badge={
        <Badge
          theme={theme}
          label={lastSync ? (lastSync.error ? "Last sync failed" : "Synced") : "Not synced"}
          tone={lastSync && !lastSync.error ? "success" : lastSync ? "warning" : "muted"}
        />
      }
    >
      {status?.clusterError && (
        <Text style={{ ...(text as object), color: theme.colors.statusWarning }}>{status.clusterError}</Text>
      )}
      <Text style={text}>
        {status
          ? "Choose what new workspaces can use. Credential values never reach this panel."
          : "Find the providers and MCP servers configured on the main daemon to choose from."}
      </Text>
      <View style={{ alignSelf: "flex-start" }}>
        <Button
          theme={theme}
          label={status ? "Refresh providers" : "Find providers"}
          icon="Search"
          primary={!status}
          disabled={busy}
          onPress={props.onFind}
        />
      </View>
      {status && (
        <View style={{ gap: 12 }}>
          <Text style={heading}>Providers</Text>
          {status.daemonError && (
            <Text style={{ ...(text as object), color: theme.colors.statusWarning }}>{status.daemonError}</Text>
          )}
          <Field theme={theme} label="Search providers" value={query} onChange={setQuery} placeholder="Search" />
          {visible.map((p) => {
            const badge = rowStateBadge(p.state);
            const missingUrl = p.selected && p.needsUrls.some((u) => !u.override);
            const description = [
              p.models === null ? "" : plural(p.models, "model"),
              p.kind === "profile" ? `Profile · extends ${p.base}` : "",
              p.hint ?? (p.id === "codex-login" || p.id === "claude-token" ? HINTS[p.id] : ""),
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <View key={p.id} style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <View style={{ flex: 1, minWidth: 200 }}>
                    <Choice
                      theme={theme}
                      label={p.label}
                      description={description}
                      checked={p.selected}
                      onChange={(on) => chooseProvider(p.id, on)}
                      disabled={busy || !p.supported || (!p.found && !p.selected)}
                    />
                  </View>
                  {p.kind === "profile" && <Badge theme={theme} label="Profile" tone="muted" />}
                  <Badge
                    theme={theme}
                    label={!p.supported ? "Unsupported" : p.found ? "Found" : "Missing"}
                    tone={p.found && p.supported ? "success" : "muted"}
                  />
                  {missingUrl && <Badge theme={theme} label="Needs URL" tone="warning" />}
                  {badge && <Badge theme={theme} label={badge.label} tone={badge.tone} />}
                </View>
                {p.id === "codex-login" && p.selected && (
                  <View style={{ paddingLeft: 30, gap: 4 }}>
                    <Text style={{ ...(text as object), color: theme.colors.statusWarning }}>
                      {value.codexMode === "access-only"
                        ? "Access-only: pods get the short-lived access token without the refresh token. Codex in a pod stops working when it expires; sync providers again to renew it."
                        : "Refreshing: every pod gets the refresh token. Pods refresh independently and can invalidate each other's login."}
                    </Text>
                  </View>
                )}
                {p.id === "claude-login" && p.selected && claudeWarning()}
                {p.selected &&
                  p.needsUrls.map((u) => (
                    <View key={u.name} style={{ paddingLeft: 30 }}>
                      <Field
                        theme={theme}
                        label={`Reachable URL for ${u.name} (now ${u.host})`}
                        value={value.profileUrls[`${p.providerId}/${u.name}`] ?? ""}
                        onChange={(v) => {
                          const next = { ...value.profileUrls };
                          if (v) next[`${p.providerId}/${u.name}`] = v;
                          else delete next[`${p.providerId}/${u.name}`];
                          set({ profileUrls: next });
                        }}
                        hint="Replace the loopback address with an endpoint reachable from pods."
                        disabled={busy}
                      />
                    </View>
                  ))}
              </View>
            );
          })}
          {!status.providers.length && !status.daemonError && (
            <Text style={text}>The main daemon reports no providers.</Text>
          )}
          {status.providers.length > 0 && !visible.length && <Text style={text}>No provider matches “{query}”.</Text>}
          {status.credentials.length > 0 && (
            <View style={{ gap: 8, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 14 }}>
              <Text style={heading}>Other credentials</Text>
              {status.credentials.map((p) =>
                row(p.id, providerLabel(p.id, p.label), {
                  found: p.found,
                  selected: p.selected,
                  state: p.state,
                  description: HINTS[p.id],
                  onChange: (on) => chooseProvider(p.id, on),
                  extra: p.id === "claude-login" && p.selected ? claudeWarning() : undefined,
                }),
              )}
            </View>
          )}
          {status.mcps.length > 0 && (
            <View style={{ gap: 8, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 14 }}>
              <Text style={heading}>MCP servers</Text>
              {status.mcps.map((m) =>
                row(`mcp-${m.name}`, m.name, {
                  found: m.found,
                  selected: m.selected,
                  state: m.state,
                  description: m.missing.length
                    ? `Missing: ${m.missing.join(", ")}`
                    : undefined,
                  onChange: (on) => set({ mcps: toggle(value.mcps, m.name, on) }),
                  extra:
                    m.selected && m.needsUrl ? (
                      <View style={{ paddingLeft: 30 }}>
                        <Field
                          theme={theme}
                          label={`Reachable URL for ${m.name}`}
                          value={value.mcpUrls[m.name] ?? ""}
                          onChange={(v) => {
                            const next = { ...value.mcpUrls };
                            if (v) next[m.name] = v;
                            else delete next[m.name];
                            set({ mcpUrls: next });
                          }}
                          hint="Replace localhost with an endpoint reachable from pods."
                          disabled={busy}
                        />
                      </View>
                    ) : undefined,
                }),
              )}
            </View>
          )}
        </View>
      )}
      <Disclosure theme={theme} label="Advanced provider settings" summary="Codex & Claude modes, OAuth cache & sync details">
        <Choice
          theme={theme}
          label="Refreshing Codex login"
          description="Copy the Codex refresh token into pods so they can renew their own access. Off (access-only) is safer: a refresh token shared by several pods can be revoked by whichever refreshes first."
          checked={value.codexMode === "refreshing"}
          onChange={(on) => set({ codexMode: on ? "refreshing" : "access-only" })}
          disabled={busy || !codex}
        />
        <Choice
          theme={theme}
          label="Refreshing Claude login"
          description="Copy the Claude refresh token into pods so they can renew their own access. Off (access-only) is safer: Anthropic rotates refresh tokens, so whichever copy refreshes first can invalidate the others, including yours on the main host. Prefer a long-lived token (`claude setup-token`)."
          checked={value.claudeMode === "refreshing"}
          onChange={(on) => set({ claudeMode: on ? "refreshing" : "access-only" })}
          disabled={busy || !claudeLogin}
        />
        {status?.oauthFile && (
          <Choice
            theme={theme}
            label="Include the entire MCP OAuth cache"
            description="Copies all file-backed OAuth entries, including unselected servers. OS-keychain credentials are not exported. Applies to the whole provider set."
            checked={value.includeMcpOAuthFile}
            onChange={(on) => set({ includeMcpOAuthFile: on })}
            disabled={busy || !value.mcps.length}
          />
        )}
        {status?.mcps
          .filter((m) => m.selected && !m.needsUrl)
          .map((m) => (
            <Field
              key={m.name}
              theme={theme}
              label={`Override URL for ${m.name}`}
              value={value.mcpUrls[m.name] ?? ""}
              onChange={(v) => {
                const next = { ...value.mcpUrls };
                if (v) next[m.name] = v;
                else delete next[m.name];
                set({ mcpUrls: next });
              }}
              placeholder="Keep configured URL"
              disabled={busy}
            />
          ))}
        <Text style={text}>
          Only selected credentials are exported to Kubernetes Secrets in {props.namespace}. Existing pods keep their writable copies; re-sync after
          credentials change.
        </Text>
        {lastSync && (
          <View style={{ gap: 4 }}>
            <Text style={text}>Last synced: {new Date(lastSync.at).toLocaleString()}</Text>
            <Text selectable style={{ ...(text as object), fontFamily: "monospace" }}>
              {lastSync.version}
            </Text>
            {lastSync.error && (
              <Text style={{ ...(text as object), color: theme.colors.statusDanger }}>{lastSync.error}</Text>
            )}
          </View>
        )}
        {status?.set && (
          <Text style={text}>
            In the cluster: {status.set.providers.length} provider{status.set.providers.length === 1 ? "" : "s"}, {status.set.mcps.length} MCP server
            {status.set.mcps.length === 1 ? "" : "s"}.
          </Text>
        )}
      </Disclosure>
      <View style={{ gap: 9 }}>
        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
          <Button theme={theme} label="Save selection" disabled={busy || saved} onPress={props.onSave} />
          <Button
            theme={theme}
            label="Sync providers"
            icon="CloudUpload"
            primary
            disabled={busy || !saved || !connected || !value.selected.length}
            onPress={props.onSync}
          />
        </View>
        <Text style={text}>
          {!connected
            ? "Connect your cluster to sync providers."
            : !saved
              ? "Save your changes before syncing."
              : !value.selected.length
                ? "Select at least one provider to sync."
                : "Writes the shared provider set once and refreshes every approved project."}
        </Text>
      </View>
    </Card>
  );
}
