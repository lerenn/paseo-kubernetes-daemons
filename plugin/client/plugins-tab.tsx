import { useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, Card, Choice, Field, type Theme } from "./components.js";
import { pluginKey, pluginState } from "../shared/plugins.js";
import { pluginSchema, type Plugin } from "../shared/settings.js";

// Applies plugins.sync results to settings.plugins (matched by source and ref).
export function applyPluginResults(
  plugins: Plugin[],
  results: { source: string; ref: string; synced: Plugin["synced"] }[],
): Plugin[] {
  return plugins.map((p) => {
    const r = results.find((x) => pluginKey(x) === pluginKey(p) && x.synced);
    return r?.synced ? { ...p, synced: r.synced } : p;
  });
}

const TONE = { synced: "success", "out-of-date": "warning", "not-synced": "muted" } as const;
const LABEL = { synced: "Synced", "out-of-date": "Out of date", "not-synced": "Not synced" } as const;

// The saved value is never displayed; typing here replaces it.
function Replace(props: { theme: Theme; name: string; busy: boolean; onValue: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <Field
      theme={props.theme}
      label={props.name}
      secret
      value={v}
      placeholder="Saved. Type to replace."
      onChange={(next) => {
        setV(next);
        if (next) props.onValue(next);
      }}
      disabled={props.busy}
    />
  );
}

function Row(props: {
  theme: Theme;
  text: object;
  plugin: Plugin;
  busy: boolean;
  onChange: (next: Plugin) => void;
  onRemove: () => void;
}) {
  const { theme, text, plugin, busy, onChange } = props;
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const state = pluginState(plugin);
  const keys = Object.keys(plugin.env).sort();
  const set = (env: Plugin["env"]) => onChange({ ...plugin, env });
  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
          <Text style={{ ...text, fontWeight: "600", color: theme.colors.foreground }} selectable>
            {plugin.source}
          </Text>
          <Text style={text}>{plugin.ref ? `Pinned to ${plugin.ref}` : "Not pinned"}</Text>
        </View>
        <Badge theme={theme} label={plugin.enabled ? LABEL[state] : "Disabled"} tone={plugin.enabled ? TONE[state] : "muted"} alignSelf="center" />
      </View>
      <Choice
        theme={theme}
        label="Install in new workspaces"
        checked={plugin.enabled}
        onChange={(enabled) => onChange({ ...plugin, enabled })}
        disabled={busy}
      />
      {keys.map((k) => (
        <View key={k} style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Replace theme={theme} name={k} busy={busy} onValue={(v) => set({ ...plugin.env, [k]: v })} />
          </View>
          <Button
            theme={theme}
            label="Remove"
            icon="Trash2"
            disabled={busy}
            onPress={() => set(Object.fromEntries(Object.entries(plugin.env).filter(([n]) => n !== k)))}
          />
        </View>
      ))}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <View style={{ flex: 1, minWidth: 140 }}>
          <Field theme={theme} label="Variable name" value={name} onChange={setName} placeholder="API_TOKEN" disabled={busy} />
        </View>
        <View style={{ flex: 1, minWidth: 140 }}>
          <Field theme={theme} label="Value" secret value={value} onChange={setValue} disabled={busy} />
        </View>
        <Button
          theme={theme}
          label="Add variable"
          disabled={busy || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !value}
          onPress={() => {
            set({ ...plugin.env, [name]: value });
            setName("");
            setValue("");
          }}
        />
      </View>
      <View style={{ flexDirection: "row" }}>
        <Button theme={theme} label="Remove plugin" icon="Trash2" danger disabled={busy} onPress={props.onRemove} />
      </View>
    </View>
  );
}

export function PluginsTab(props: {
  theme: Theme;
  text: object;
  value: Plugin[];
  busy: boolean;
  saved: boolean;
  connected: boolean;
  onChange: (next: Plugin[]) => void;
  onSave: () => void;
  onSync: () => void;
}) {
  const { theme, text, value, busy } = props;
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const candidate = pluginSchema.safeParse({ source, ref });
  const duplicate = value.some((p) => pluginKey(p) === pluginKey({ source, ref }));
  return (
    <Card
      theme={theme}
      title="Plugins"
      icon="Puzzle"
      description="Plugins every workspace daemon installs."
      badge={<Badge theme={theme} label={`${value.filter((p) => p.enabled).length} enabled`} />}
    >
      <Text style={text}>
        Only the plugins you add here are installed. Nothing is copied from this daemon. Plugins are installed{" "}
        <Text style={{ fontWeight: "600" }}>after the workspace daemon starts</Text>, so they appear shortly after a new workspace is
        online. Plugins run unsandboxed: pin each one to a tag or commit. Variable values are stored in the cluster as a Secret and are never shown again.
      </Text>
      {value.map((p) => (
        <Row
          key={pluginKey(p)}
          theme={theme}
          text={text}
          plugin={p}
          busy={busy}
          onChange={(next) => props.onChange(value.map((x) => (x === p ? next : x)))}
          onRemove={() => props.onChange(value.filter((x) => x !== p))}
        />
      ))}
      {value.length === 0 && <Text style={text}>No plugins added.</Text>}
      <View style={{ gap: 10, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 12 }}>
        <Field theme={theme} label="Plugin source" value={source} onChange={setSource} placeholder="git:owner/repo or owner/slug" disabled={busy} />
        <Field theme={theme} label="Tag or commit" value={ref} onChange={setRef} placeholder="v1.2.0" hint="Recommended: an unpinned plugin changes under you." disabled={busy} />
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            label="Add plugin"
            icon="Plus"
            disabled={busy || !candidate.success || duplicate || value.length >= 16}
            onPress={() => {
              if (!candidate.success) return;
              props.onChange([...value, candidate.data]);
              setSource("");
              setRef("");
            }}
          />
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button theme={theme} label="Save" primary disabled={busy || props.saved} onPress={props.onSave} />
        <Button theme={theme} label="Sync plugins" icon="RefreshCw" disabled={busy || !props.saved || !props.connected} onPress={props.onSync} />
      </View>
      {!props.saved && <Text style={text}>Save your changes before syncing.</Text>}
    </Card>
  );
}
