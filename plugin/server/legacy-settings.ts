import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Paseo scopes plugin settings by installation id: <PASEO_HOME>/plugin-settings/<plugin id>/<settings id>.json.
// There is no API to read another plugin's settings, so on first start under the new id we copy the old
// document once (never overwriting), after renaming the values that pointed at the pre-0.5 resource names.
const OLD_PLUGIN = "kubernetes-workspaces";
const NEW_PLUGIN = "kubernetes-daemons";
const SETTINGS_ID = "workspace-setup";

export function rewriteLegacyValues(values: unknown) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return values;
  const v = { ...(values as Record<string, unknown>) };
  if (v.namespace === "paseo-workspaces") v.namespace = "paseo-daemons";
  if (typeof v.image === "string" && /^ghcr\.io\/lerenn\/paseo-workspace(:|$)/.test(v.image)) v.image = "";
  // The sync digest refers to Secrets of the old stack: force a fresh sync.
  if ("synced" in v) v.synced = null;
  return v;
}

export async function carryOverLegacySettings(
  home = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo"),
): Promise<"copied" | "none"> {
  const root = path.join(home, "plugin-settings");
  const from = path.join(root, OLD_PLUGIN, `${SETTINGS_ID}.json`);
  const to = path.join(root, NEW_PLUGIN, `${SETTINGS_ID}.json`);
  let envelope: { version?: unknown; values?: unknown };
  try {
    envelope = JSON.parse(await readFile(from, "utf8"));
  } catch {
    return "none";
  }
  if (!envelope || typeof envelope !== "object") return "none";
  await mkdir(path.dirname(to), { recursive: true });
  try {
    // "wx": an existing new document always wins.
    await writeFile(to, JSON.stringify({ ...envelope, values: rewriteLegacyValues(envelope.values) }), {
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "none";
    throw error;
  }
  return "copied";
}
