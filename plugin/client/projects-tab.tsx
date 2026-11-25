import { useState } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { Badge, Button, Card, Choice, Disclosure, Field, type Theme } from "./components.js";
import type { projectsDiscover, projectsList, projectsUpdate } from "../shared/contracts.js";
import { ProjectPodSettings, type CheckPods } from "./pods-tab.js";
import type { Pods, PodsOverride } from "../shared/pods.js";
import {
  LOCAL_SEARCH_THRESHOLD,
  filterLocal,
  localAction,
  localBadge,
  localState,
  syncedSummary,
  type LocalRow,
  plural,
  projectName,
  projectStateBadge,
  providerLabel,
  providersBadge,
  removeCopy,
  workspaceCountText,
} from "./view.js";

export type ProjectRow = z.output<typeof projectsList.output>["projects"][number];
export type Discovered = z.output<typeof projectsDiscover.output>;
export type UpdateInput = z.input<typeof projectsUpdate.input>;
type ProviderId = NonNullable<ProjectRow["providerSubset"]>[number];
type Mcp = Discovered["mcps"][number];
type Approval = { syncAfter?: boolean; id?: string; path?: string; repository: string; revision: string; mcps: Mcp[]; selected: string[] };

export interface ProjectsActions {
  discover: (path: string) => Promise<Discovered>;
  addUrl: (repository: string, revision: string) => Promise<void>;
  // Adds a checkout project and approves it with the chosen project MCPs in one go.
  addApproved: (path: string, revision: string, mcps: string[]) => Promise<void>;
  approve: (id: string, mcps: string[] | undefined) => Promise<void>;
  unapprove: (id: string) => Promise<void>;
  update: (input: UpdateInput) => Promise<void>;
  sync: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const tri = (v: boolean | undefined) => (v === undefined ? "default" : v ? "on" : "off");

function Edit(props: {
  podsGlobal: Pods;
  globalDocker: boolean;
  globalEphemeral: boolean;
  checkPods?: CheckPods;
  theme: Theme;
  text: object;
  row: ProjectRow;
  selectedProviders: string[];
  busy: boolean;
  actions: ProjectsActions;
}) {
  const { theme, text, row, busy, actions } = props;
  const [revision, setRevision] = useState(row.revision);
  const [path, setPath] = useState(row.path ?? "");
  const [subset, setSubset] = useState<ProviderId[] | null>(row.providerSubset);
  const [mcps, setMcps] = useState<string[]>(row.projectMcps);
  const [known, setKnown] = useState<Mcp[] | null>(null);
  const [image, setImage] = useState(row.overrides.image ?? "");
  const [docker, setDocker] = useState<boolean | undefined>(row.overrides.docker);
  const [ephemeral, setEphemeral] = useState<boolean | undefined>(row.overrides.ephemeral);
  const [podsOverride, setPodsOverride] = useState<PodsOverride | undefined>(row.overrides.pods);
  const triButtons = (value: boolean | undefined, set: (v: boolean | undefined) => void) => (
    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
      {([["default", undefined], ["on", true], ["off", false]] as const).map(([label, v]) => (
        <Button
          key={label}
          theme={theme}
          label={label === "default" ? "Default" : label === "on" ? "On" : "Off"}
          primary={tri(value) === label}
          disabled={busy}
          onPress={() => set(v)}
        />
      ))}
    </View>
  );
  const label = { ...(text as object), fontWeight: "600" as const, color: theme.colors.foreground };
  const mcpNames = [...new Set([...(known?.map((m) => m.name) ?? []), ...mcps])];
  return (
    <View style={{ gap: 12 }}>
      <Field theme={theme} label="Branch, tag or commit" value={revision} onChange={setRevision} placeholder="Default branch" disabled={busy} />
      <Field
        theme={theme}
        label="Checkout on this daemon"
        value={path}
        onChange={setPath}
        placeholder="/path/to/checkout (optional)"
        hint="Needed only for project MCP servers. Its origin must match the repository."
        disabled={busy}
      />
      <Choice
        theme={theme}
        label="Use only some providers"
        description="Off: this project gets every provider selected on the Providers tab."
        checked={subset !== null}
        onChange={(on) => setSubset(on ? ([...props.selectedProviders] as ProviderId[]) : null)}
        disabled={busy || !props.selectedProviders.length}
      />
      {subset !== null &&
        props.selectedProviders.map((id) => (
          <Choice
            key={id}
            theme={theme}
            label={providerLabel(id)}
            checked={subset.includes(id as ProviderId)}
            onChange={(on) => setSubset(on ? [...new Set([...subset, id as ProviderId])] : subset.filter((x) => x !== id))}
            disabled={busy}
          />
        ))}
      {path.trim() !== "" && (
        <View style={{ gap: 6 }}>
          <Text style={label}>Project MCP servers</Text>
          <View style={{ alignSelf: "flex-start" }}>
            <Button
              theme={theme}
              label="Find project MCPs"
              icon="Search"
              disabled={busy}
              onPress={() => void actions.discover(path.trim()).then((d) => setKnown(d.mcps))}
            />
          </View>
          {mcpNames.length === 0 && <Text style={text}>No project MCP servers selected.</Text>}
          {mcpNames.map((n) => {
            const m = known?.find((x) => x.name === n);
            return (
              <Choice
                key={n}
                theme={theme}
                label={n}
                description={m?.missing.length ? `Missing: ${m.missing.join(", ")}` : undefined}
                checked={mcps.includes(n)}
                onChange={(on) => setMcps(on ? [...new Set([...mcps, n])] : mcps.filter((x) => x !== n))}
                disabled={busy || (!!m && m.missing.length > 0)}
              />
            );
          })}
        </View>
      )}
      <Field
        theme={theme}
        label="Workspace image override"
        value={image}
        onChange={setImage}
        placeholder="Use the cluster default"
        hint="Applies to new workspaces of this project right after saving."
        disabled={busy}
      />
      <Text style={label}>Docker</Text>
      {triButtons(docker, setDocker)}
      <Text style={label}>Ephemeral storage</Text>
      {triButtons(ephemeral, setEphemeral)}
      <Disclosure theme={theme} title="Pod settings" label="Pod settings" summary={podsOverride ? "Overridden" : "Using global defaults"}>
        <ProjectPodSettings
          theme={theme}
          text={text}
          global={props.podsGlobal}
          value={row.overrides.pods}
          docker={docker ?? props.globalDocker}
          ephemeral={ephemeral ?? props.globalEphemeral}
          busy={busy}
          {...(props.checkPods ? { check: props.checkPods } : {})}
          onChange={setPodsOverride}
        />
      </Disclosure>
      <View style={{ alignSelf: "flex-start" }}>
        <Button
          theme={theme}
          label="Save project"
          primary
          disabled={busy}
          onPress={() =>
            void actions.update({
              id: row.id,
              revision: revision.trim(),
              path: path.trim() === "" ? null : path.trim(),
              providerSubset: subset,
              projectMcps: path.trim() === "" ? [] : mcps,
              overrides: {
                image: image.trim() === "" ? null : image.trim(),
                docker: docker ?? null,
                ephemeral: ephemeral ?? null,
                pods: podsOverride ?? null,
              },
            })
          }
        />
      </View>
    </View>
  );
}

export function ProjectsTab(props: {
  theme: Theme;
  text: object;
  projects: ProjectRow[] | null;
  // Projects Paseo knows on this daemon (null when unavailable).
  local: LocalRow[] | null;
  selectedProviders: string[];
  busy: boolean;
  saved: boolean;
  connected: boolean;
  actions: ProjectsActions;
  podsGlobal: Pods;
  globalDocker: boolean;
  globalEphemeral: boolean;
  checkPods?: CheckPods;
}) {
  const { theme, text, busy, actions, projects } = props;
  const [mode, setMode] = useState<"url" | "path">("url");
  const [source, setSource] = useState("");
  const [revision, setRevision] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // "Review all": candidates still to walk through the approval dialog, one at a time.
  const [queue, setQueue] = useState<LocalRow[]>([]);
  const writable = props.saved && !busy;
  const heading = { ...(text as object), fontWeight: "600" as const, color: theme.colors.foreground };
  const panel = { backgroundColor: theme.colors.surface2, padding: 14, borderRadius: 8, gap: 12 };

  const startAdd = async () => {
    const v = source.trim();
    if (mode === "url") {
      await actions.addUrl(v, revision.trim());
      setSource("");
      setRevision("");
      return;
    }
    const d = await actions.discover(v);
    setApproval({ path: v, repository: d.repositoryUrl, revision: revision.trim(), mcps: d.mcps, selected: [] });
  };
  const startApprove = async (row: ProjectRow) => {
    const d = row.path ? await actions.discover(row.path) : { repositoryUrl: row.repository, mcps: [] };
    setApproval({
      id: row.id,
      path: row.path ?? undefined,
      repository: row.repository,
      revision: row.revision,
      mcps: d.mcps,
      selected: row.projectMcps.filter((n) => d.mcps.some((m) => m.name === n)),
    });
  };
  // Every path into approval goes through this dialog: nothing is trusted or synced without it.
  const startLocal = async (row: LocalRow, rest: LocalRow[] = []) => {
    const live = (projects ?? []).find((p) => p.id === row.id);
    setQueue(rest);
    if (live) return startApproveThenSync(live);
    const d = await actions.discover(row.path);
    setApproval({ syncAfter: true, path: row.path, repository: d.repositoryUrl, revision: "", mcps: d.mcps, selected: [] });
  };
  const startApproveThenSync = async (row: ProjectRow) => {
    await startApprove(row);
    setApproval((a) => (a ? { ...a, syncAfter: true } : a));
  };
  const next = async (rest: LocalRow[]) => {
    const [head, ...tail] = rest;
    if (head) await startLocal(head, tail);
    else setQueue([]);
  };
  const confirm = async () => {
    if (!approval) return;
    const a = approval;
    let id = a.id;
    if (a.id) await actions.approve(a.id, a.path ? a.selected : undefined);
    else if (a.path) {
      id = (local ?? []).find((r) => r.repository === a.repository)?.id ?? undefined;
      await actions.addApproved(a.path, a.revision, a.selected);
    }
    if (a.syncAfter && id && props.connected) await actions.sync(id);
    setApproval(null);
    setSource("");
    setRevision("");
    await next(queue);
  };
  const local = props.local;
  const { synced, total } = syncedSummary(projects ?? [], local);
  const visibleLocal = filterLocal(local ?? [], query);
  const pending = (local ?? []).filter((r) => {
    const a = localAction(localState(r, projects));
    return a === "add" || a === "approve";
  });
  return (
    <Card
      theme={theme}
      title="Projects"
      icon="FolderGit2"
      description="Repositories that new workspaces can start from."
      badge={<Badge theme={theme} label={projects ? `${synced} of ${plural(total, "project")} synced` : "Loading"} tone={total > 0 && synced === total ? "success" : "muted"} />}
    >
      {local && local.length > 0 && (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Text style={{ ...heading, flex: 1 }}>Projects on this daemon</Text>
            {pending.length > 0 && (
              <Button
                theme={theme}
                label={`Review all (${pending.length})`}
                disabled={!writable}
                onPress={() => void startLocal(pending[0]!, pending.slice(1))}
              />
            )}
          </View>
          <Text style={text}>
            Projects Paseo already knows here. Adding one opens its approval dialog, then syncs it. “Review all” walks the dialog one project at a time; nothing is approved without it.
          </Text>
          {local.length > LOCAL_SEARCH_THRESHOLD && (
            <Field theme={theme} label="Search" value={query} onChange={setQuery} placeholder="Name, path or repository" />
          )}
          {visibleLocal.map((r) => {
            const state = r.status === "skipped" ? "skipped" : localState(r, projects);
            const badge = localBadge(state);
            const act = localAction(state);
            return (
              <View key={`${r.path}`} style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 10 }}>
                <View style={{ flex: 1, minWidth: 200, gap: 2 }}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.foreground }}>{r.name}</Text>
                  <Text selectable style={text}>{r.repository ? `${r.host ?? ""} · ${r.repository}` : (r.reason ?? "")}</Text>
                  <Text selectable style={text}>{r.path}</Text>
                </View>
                <Badge theme={theme} label={badge.label} tone={badge.tone} />
                {act && (
                  <Button
                    theme={theme}
                    label={act === "add" ? "Add & sync" : act === "approve" ? "Approve & sync" : act === "sync" ? "Sync" : "Sync again"}
                    primary={act !== "resync"}
                    disabled={!writable || (!props.connected && act !== "add" && act !== "approve")}
                    onPress={() =>
                      act === "sync" || act === "resync"
                        ? void actions.sync(r.id!)
                        : void startLocal(r)
                    }
                  />
                )}
              </View>
            );
          })}
          {visibleLocal.length === 0 && <Text style={text}>No match.</Text>}
        </View>
      )}
      <Disclosure theme={theme} label="Add another project" summary="By repository URL or checkout path">
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <Button theme={theme} label="Repository URL" primary={mode === "url"} disabled={busy} onPress={() => { setMode("url"); setApproval(null); }} />
          <Button theme={theme} label="Checkout on this daemon" primary={mode === "path"} disabled={busy} onPress={() => { setMode("path"); setApproval(null); }} />
        </View>
        <Field
          theme={theme}
          label={mode === "url" ? "Repository URL" : "Checkout path"}
          value={source}
          onChange={(v) => { setSource(v); setApproval(null); }}
          placeholder={mode === "url" ? "https://github.com/owner/repository" : "/path/to/your/repository"}
          hint={mode === "url" ? "A project added by URL has no project MCP servers." : "Reads the origin remote and the project's own MCP servers from the main daemon."}
          disabled={busy}
        />
        <Field theme={theme} label="Branch, tag or commit" value={revision} onChange={setRevision} placeholder="Default branch" disabled={busy} />
        <View style={{ alignSelf: "flex-start" }}>
          <Button
            theme={theme}
            label={mode === "url" ? "Add project" : "Review checkout"}
            icon="Plus"
            primary
            disabled={!writable || !source.trim()}
            onPress={() => void startAdd()}
          />
        </View>
        {!props.saved && <Text style={text}>Save your changes before editing projects.</Text>}
      </View>
      </Disclosure>
      {approval && (
        <View style={panel}>
          <Text style={heading}>Approve {projectName(approval.repository)}?</Text>
          <Text selectable style={text}>{approval.repository}</Text>
          <Text style={text}>Revision: {approval.revision || "default branch"}</Text>
          <Text style={text}>
            Approving lets new workspaces for exactly this repository start with its project configuration.
          </Text>
          {approval.path && (
            approval.mcps.length ? (
              <View style={{ gap: 4 }}>
                <Text style={heading}>Project MCP servers</Text>
                {approval.mcps.map((m) => (
                  <Choice
                    key={m.name}
                    theme={theme}
                    label={m.name}
                    description={m.missing.length ? `Missing: ${m.missing.join(", ")}` : m.transport === "STDIO" ? "Requires its executable in the workspace image" : undefined}
                    checked={approval.selected.includes(m.name)}
                    onChange={(on) => setApproval({ ...approval, selected: on ? [...new Set([...approval.selected, m.name])] : approval.selected.filter((x) => x !== m.name) })}
                    disabled={busy || m.missing.length > 0}
                  />
                ))}
              </View>
            ) : (
              <Text style={text}>This checkout defines no project MCP servers.</Text>
            )
          )}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button theme={theme} label={approval.syncAfter ? (approval.id ? "Approve & sync" : "Add, approve & sync") : approval.id ? "Approve" : "Add and approve"} primary disabled={busy} onPress={() => void confirm()} />
            <Button theme={theme} label={queue.length ? "Skip" : "Cancel"} onPress={() => { setApproval(null); void next(queue); }} />
            {queue.length > 0 && <Button theme={theme} label="Stop review" onPress={() => { setApproval(null); setQueue([]); }} />}
          </View>
        </View>
      )}
      {projects && projects.length === 0 && (
        <Text style={text}>No projects yet. Add a repository above to start workspaces from it.</Text>
      )}
      {(projects ?? []).map((row) => {
        const badge = projectStateBadge(row.state);
        const name = projectName(row.repository);
        return (
          <View key={row.id} style={{ borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 16, gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <View style={{ flex: 1, minWidth: 200, gap: 4 }}>
                <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.foreground }}>{name}</Text>
                <Text selectable style={text}>{row.repository}</Text>
                <Text style={text}>
                  {providersBadge(row.providers, row.providerSubset)} · {workspaceCountText(row.workspaces)}
                  {row.synced ? ` · synced ${new Date(row.synced.at).toLocaleString()}` : ""}
                </Text>
              </View>
              <Badge theme={theme} label={badge.label} tone={badge.tone} />
              {row.trusted && <Badge theme={theme} label="Approved" tone="success" />}
            </View>
            {row.error && <Text style={{ ...(text as object), color: theme.colors.statusDanger }}>{row.error}</Text>}
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {!row.trusted && (
                <Button theme={theme} label="Approve" primary disabled={!writable} onPress={() => void startApprove(row)} />
              )}
              {row.trusted && (
                <Button
                  theme={theme}
                  label="Sync project"
                  icon="CloudUpload"
                  primary={row.state !== "synced"}
                  disabled={!writable || !props.connected}
                  onPress={() => void actions.sync(row.id)}
                />
              )}
              {row.trusted && <Button theme={theme} label="Unapprove" disabled={!writable} onPress={() => void actions.unapprove(row.id)} />}
              <Button theme={theme} label="Remove" danger disabled={!writable} onPress={() => setRemoving(row.id)} />
            </View>
            {removing === row.id && (
              <View style={panel}>
                <Text style={text}>{removeCopy(name, row.workspaces)}</Text>
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <Button theme={theme} label="Remove project" danger disabled={busy} onPress={() => void actions.remove(row.id).then(() => setRemoving(null))} />
                  <Button theme={theme} label="Cancel" onPress={() => setRemoving(null)} />
                </View>
              </View>
            )}
            <Disclosure theme={theme} label="Edit project" summary="Revision, providers, MCPs & overrides">
              <Edit podsGlobal={props.podsGlobal} globalDocker={props.globalDocker} globalEphemeral={props.globalEphemeral} {...(props.checkPods ? { checkPods: props.checkPods } : {})} theme={theme} text={text} row={row} selectedProviders={props.selectedProviders} busy={!writable} actions={actions} />
            </Disclosure>
          </View>
        );
      })}
    </Card>
  );
}
