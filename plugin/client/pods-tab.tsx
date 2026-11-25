import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import { Badge, Button, Card, Choice, Disclosure, Field, type Theme } from "./components.js";
import type { podsCheck, podsStatus } from "../shared/contracts.js";
import { mergePods, validatePods, type Pods, type PodsOverride } from "../shared/pods.js";
import { capacityText, cleanOverride, issueFor, podsEqual } from "./view.js";

export type PodsStatus = z.output<typeof podsStatus.output>;
export type PodsCheck = z.output<typeof podsCheck.output>;
export type CheckPods = (input: { pods: Pods; override?: PodsOverride; docker: boolean; ephemeral: boolean }) => Promise<PodsCheck>;

type Group = "compute" | "storage" | "docker";
type Values = Partial<Record<Group, Record<string, string | undefined>>>;

const COMPUTE: [string, string][] = [
  ["cpuRequest", "CPU request"],
  ["cpuLimit", "CPU limit"],
  ["memoryRequest", "Memory request"],
  ["memoryLimit", "Memory limit"],
];
const SCRATCH: [string, string][] = [
  ["scratchRequest", "Scratch space request"],
  ["scratchLimit", "Scratch space limit"],
];

// Runs the server-side check (quota and storage class warnings) shortly after the values settle.
// Failures are silent: without cluster access the inline validation still works.
function useCheck(check: CheckPods | undefined, pods: Pods, override: PodsOverride | undefined, docker: boolean, ephemeral: boolean) {
  const [result, setResult] = useState<PodsCheck | null>(null);
  const key = JSON.stringify([pods, override, docker, ephemeral]);
  useEffect(() => {
    if (!check) return;
    let live = true;
    const timer = setTimeout(() => {
      check({ pods, ...(override ? { override } : {}), docker, ephemeral })
        .then((r) => live && setResult(r))
        .catch(() => live && setResult(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, !!check]);
  return result;
}

// Editable fields. `base` set: an override editor (blank = inherit, placeholder shows the global value).
export function PodFields(props: {
  theme: Theme;
  text: object;
  values: Values;
  base?: Pods;
  docker: boolean;
  ephemeral: boolean;
  classes: PodsStatus["storageClasses"];
  issues: { path: string; message: string }[];
  busy: boolean;
  onChange: (next: Values) => void;
}) {
  const { theme, text, values, base, busy, issues } = props;
  const heading = { ...(text as object), fontWeight: "600" as const, color: theme.colors.foreground };
  const set = (group: Group, key: string, v: string) =>
    props.onChange({ ...values, [group]: { ...values[group], [key]: v } });
  const field = (group: Group, key: string, label: string, hint?: string) => {
    const err = issueFor(issues, `${group}.${key}`);
    const inherited = (base?.[group] as Record<string, string> | undefined)?.[key];
    return (
      <View key={`${group}.${key}`} style={{ flex: 1, minWidth: 180, gap: 4 }}>
        <Field
          theme={theme}
          label={label}
          value={values[group]?.[key] ?? ""}
          onChange={(v) => set(group, key, v)}
          placeholder={base ? (inherited ? `Global: ${inherited}` : "Global default") : undefined}
          hint={err ? undefined : hint}
          disabled={busy}
        />
        {err && <Text style={{ ...(text as object), color: theme.colors.statusDanger }}>{err}</Text>}
      </View>
    );
  };
  const row = (children: React.ReactNode) => (
    <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>{children}</View>
  );
  const classNames = props.classes?.map((c) => c.name) ?? [];
  const current = values.storage?.storageClassName ?? "";
  return (
    <View style={{ gap: 14 }}>
      <Text style={heading}>Compute</Text>
      {row(COMPUTE.slice(0, 2).map(([k, l]) => field("compute", k, l, k === "cpuRequest" ? "Cores or millicores, e.g. 250m or 2." : undefined)))}
      {row(COMPUTE.slice(2).map(([k, l]) => field("compute", k, l, k === "memoryRequest" ? "e.g. 512Mi or 4Gi." : undefined)))}
      <Disclosure theme={theme} label="Scratch space" summary="Ephemeral-storage request and limit">
        {row(SCRATCH.map(([k, l]) => field("compute", k, l)))}
      </Disclosure>
      <Text style={heading}>Storage</Text>
      {row([
        field(
          "storage",
          "size",
          "Volume size",
          `Empty uses ${props.ephemeral ? "4Gi (ephemeral)" : "10Gi (persistent)"}. At least 1Gi.`,
        ),
        field("storage", "storageClassName", "Storage class", props.ephemeral ? "Ignored for ephemeral workspaces." : "Empty uses the cluster default class."),
      ])}
      {classNames.length > 0 && !props.ephemeral && (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Text style={text}>Classes:</Text>
          {["", ...classNames].map((n) => (
            <Button
              key={n || "default"}
              theme={theme}
              label={n || "Default"}
              primary={current === n}
              disabled={busy}
              onPress={() => set("storage", "storageClassName", n)}
            />
          ))}
        </View>
      )}
      {props.docker && (
        <View style={{ gap: 14, borderTopWidth: 1, borderColor: theme.colors.border, paddingTop: 14 }}>
          <Text style={heading}>Docker sidecar</Text>
          <Text style={{ ...(text as object), color: theme.colors.statusWarning }}>
            The Docker sidecar runs privileged. Size it only as much as builds need.
          </Text>
          {row(COMPUTE.slice(0, 2).map(([k, l]) => field("docker", k, l)))}
          {row(COMPUTE.slice(2).map(([k, l]) => field("docker", k, l)))}
          {row([
            field("docker", "scratchLimit", "Scratch space limit"),
            field("docker", "dataSize", "Data volume size", "Image layers and build cache (at least 1Gi)."),
          ])}
        </View>
      )}
    </View>
  );
}

export function PodNotes(props: { theme: Theme; text: object; check: PodsCheck | null; classes: PodsStatus["storageClasses"] }) {
  const { theme, text, check } = props;
  return (
    <View style={{ gap: 6 }}>
      {check?.warnings.map((w) => (
        <Text key={w} style={{ ...(text as object), color: theme.colors.statusWarning }}>
          {w}
        </Text>
      ))}
      {check && <Text style={text}>{capacityText(check.perPod, check.fit)}</Text>}
    </View>
  );
}

// Per-project override editor, shown in the project's edit panel (Projects tab).
export function ProjectPodSettings(props: {
  theme: Theme;
  text: object;
  global: Pods;
  value: PodsOverride | undefined;
  docker: boolean;
  ephemeral: boolean;
  busy: boolean;
  check?: CheckPods;
  onChange: (next: PodsOverride | undefined) => void;
}) {
  const { theme, text } = props;
  const [values, setValues] = useState<Values>((props.value as Values) ?? {});
  const override = useMemo(() => cleanOverride(values as PodsOverride), [JSON.stringify(values)]);
  const issues = useMemo(() => validatePods(mergePods(props.global, override)), [props.global, override]);
  const result = useCheck(props.check, props.global, override, props.docker, props.ephemeral);
  useEffect(() => props.onChange(override), [override]);
  return (
    <View style={{ gap: 12 }}>
      <Text style={text}>Leave a field empty to use the global value from the Pods tab. Applies to new workspaces of this project only.</Text>
      <PodFields
        theme={theme}
        text={text}
        values={values}
        base={props.global}
        docker={props.docker}
        ephemeral={props.ephemeral}
        classes={null}
        issues={issues}
        busy={props.busy}
        onChange={setValues}
      />
      <PodNotes theme={theme} text={text} check={result} classes={null} />
      {override && (
        <View style={{ alignSelf: "flex-start" }}>
          <Button theme={theme} label="Clear pod overrides" disabled={props.busy} onPress={() => setValues({})} />
        </View>
      )}
    </View>
  );
}

export function PodsTab(props: {
  theme: Theme;
  text: object;
  value: Pods;
  status: PodsStatus | null;
  docker: boolean;
  ephemeral: boolean;
  busy: boolean;
  saved: boolean;
  check: CheckPods;
  onChange: (next: Pods) => void;
  onRefresh: () => void;
  onSave: () => void;
}) {
  const { theme, text, value, status, busy, docker, ephemeral } = props;
  const issues = useMemo(() => validatePods(value), [value]);
  const result = useCheck(props.check, value, undefined, docker, ephemeral);
  const builtin = status?.builtin;
  const atDefaults = builtin ? podsEqual(value, builtin) : false;
  const quotas = status?.quotas ?? null;
  return (
    <Card
      theme={theme}
      title="Pods"
      icon="Cpu"
      description="Compute, storage and Docker sizing for new workspaces."
      badge={<Badge theme={theme} label={atDefaults ? "Defaults" : "Customised"} tone={atDefaults ? "muted" : "success"} />}
    >
      <Text style={text}>
        Changes apply to <Text style={{ fontWeight: "600" }}>new workspaces only</Text>. Existing workspaces keep the values they were created with. Projects can override
        any field from their edit panel on the Projects tab.
      </Text>
      <View style={{ gap: 4 }}>
        {result && <Text style={text}>{capacityText(result.perPod, result.fit)}</Text>}
        {quotas && quotas.length > 0 && (
          <Text style={text}>
            Namespace quota: {quotas.map((q) => Object.entries(q.hard).map(([k, v]) => `${k} ${v}`).join(", ")).join("; ")}.
          </Text>
        )}
        {quotas && quotas.length === 0 && <Text style={text}>No namespace quota is set.</Text>}
      </View>
      <PodFields
        theme={theme}
        text={text}
        values={value}
        docker={docker}
        ephemeral={ephemeral}
        classes={status?.storageClasses ?? null}
        issues={issues}
        busy={busy}
        onChange={(v) => props.onChange({ ...value, ...(v as Pods) })}
      />
      {(result?.warnings.length ?? 0) > 0 && (
        <View style={{ gap: 4 }}>
          {result!.warnings.map((w) => (
            <Text key={w} style={{ ...(text as object), color: theme.colors.statusWarning }}>
              {w}
            </Text>
          ))}
        </View>
      )}
      <Disclosure theme={theme} label="About quota and storage" summary="Pending vs rejected, resizing volumes">
        <Text style={text}>
          A namespace quota that is full rejects the pod, so the workspace is retried and reports "Quota exceeded": raise the quota or lower the requests. When
          the cluster has no node with enough free CPU or memory the pod stays Pending with the scheduler's reason shown in the Workspaces tab.
        </Text>
        <Text style={text}>
          A volume cannot shrink, and growing an existing one is a manual operation that needs a storage class with volume expansion. Ephemeral workspaces ignore the
          class; their size is a limit on the pod's scratch space.
        </Text>
        {status?.storageClasses === null && (
          <Text style={text}>Storage classes cannot be read with the current permissions, so class names are not checked.</Text>
        )}
      </Disclosure>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button theme={theme} label="Save pod settings" primary disabled={busy || props.saved || issues.length > 0} onPress={props.onSave} />
        <Button
          theme={theme}
          label="Reset to defaults"
          icon="RotateCcw"
          disabled={busy || !builtin || atDefaults}
          onPress={() => builtin && props.onChange(builtin)}
        />
        <Button theme={theme} label="Refresh cluster info" icon="RefreshCw" disabled={busy} onPress={props.onRefresh} />
      </View>
      {issues.length > 0 && <Text style={{ ...(text as object), color: theme.colors.statusDanger }}>Fix the highlighted fields to save.</Text>}
    </Card>
  );
}
