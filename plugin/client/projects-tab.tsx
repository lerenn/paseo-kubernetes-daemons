import { useState } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { Badge, Button, Card, Choice, Disclosure, Field, type Theme } from "./components.js";
import type { projectsDiscover, projectsList, projectsUpdate } from "../shared/contracts.js";
import {
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
type Approval = { id?: string; path?: string; repository: string; revision: string; mcps: Mcp[]; selected: string[] };

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
  selectedProviders: string[];
  busy: boolean;
  saved: boolean;
  connected: boolean;
  actions: ProjectsActions;
}) {
  const { theme, text, busy, actions, projects } = props;
  const [mode, setMode] = useState<"url" | "path">("url");
  const [source, setSource] = useState("");
  const [revision, setRevision] = useState("");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
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
  const confirm = async () => {
    if (!approval) return;
    if (approval.id) await actions.approve(approval.id, approval.path ? approval.selected : undefined);
    else if (approval.path) await actions.addApproved(approval.path, approval.revision, approval.selected);
    setApproval(null);
    setSource("");
    setRevision("");
  };
  const synced = (projects ?? []).filter((p) => p.state === "synced").length;
  return (
    <Card
      theme={theme}
      title="Projects"
      icon="FolderGit2"
      description="Repositories that new workspaces can start from."
      badge={<Badge theme={theme} label={projects ? `${synced} of ${plural(projects.length, "project")} synced` : "Loading"} tone={projects?.length && synced === projects.length ? "success" : "muted"} />}
    >
      <View style={{ gap: 10 }}>
        <Text style={heading}>Add a project</Text>
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
            <Button theme={theme} label={approval.id ? "Approve" : "Add and approve"} primary disabled={busy} onPress={() => void confirm()} />
            <Button theme={theme} label="Cancel" onPress={() => setApproval(null)} />
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
              <Edit theme={theme} text={text} row={row} selectedProviders={props.selectedProviders} busy={!writable} actions={actions} />
            </Disclosure>
          </View>
        );
      })}
    </Card>
  );
}
