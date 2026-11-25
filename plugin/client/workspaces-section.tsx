import { Text, View } from "react-native";
import { Badge, Button, Card, Disclosure, Field, type Theme } from "./components.js";
import { Icon } from "@getpaseo/plugin/client/ui";
import { PENDING_HELP, pendingReason } from "./view.js";

export type Environment = {
  message?: string;
  name: string;
  phase: string;
  hostStatus: string | null;
  serverId: string | null;
  cwd: string;
  error?: { message?: string } | null;
};

// The workspace list and its actions; rendered below the setup summary on the Overview tab.
export function WorkspacesSection({
  theme,
  text,
  rows,
  name,
  setName,
  wide,
  busy,
  saved,
  connected,
  providerSynced,
  canCreate,
  deleting,
  setDeleting,
  canOpen,
  onCreate,
  onRefresh,
  onOpen,
  onDelete,
}: {
  theme: Theme;
  text: { color: string; fontSize: number; lineHeight: number };
  rows: Environment[];
  name: string;
  setName: (value: string) => void;
  wide: boolean;
  busy: boolean;
  saved: boolean;
  connected: boolean;
  providerSynced: boolean;
  canCreate: boolean;
  deleting: string | null;
  setDeleting: (name: string | null) => void;
  canOpen: boolean;
  onCreate: () => void;
  onRefresh: () => void;
  onOpen: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  return (
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
                  onPress={onCreate}
                />
                <Button
                  theme={theme}
                  label="Refresh"
                  icon="RefreshCw"
                  disabled={busy || !saved || !connected}
                  onPress={onRefresh}
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
                            : row.phase === "Failed" || row.phase === "Pending"
                              ? "warning"
                              : "muted"
                        }
                      />
                      {row.hostStatus === "online" && canOpen && (
                        <Button
                          theme={theme}
                          label="Open workspace"
                          primary
                          disabled={busy}
                          onPress={() => onOpen(row.name)}
                        />
                      )}
                      <Button
                        theme={theme}
                        label="Release"
                        disabled={busy}
                        onPress={() => setDeleting(row.name)}
                      />
                    </View>
                    {pendingReason(row.phase, row.message ?? "") ? (
                      <View style={{ gap: 4 }}>
                        <Text style={{ ...text, color: theme.colors.statusWarning }}>
                          Pending: {row.message}
                        </Text>
                        <Text style={text}>{PENDING_HELP} Pod sizes are set on the Pods tab.</Text>
                      </View>
                    ) : (
                      row.message && <Text style={text}>{row.message}</Text>
                    )}
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
                            onPress={() => onDelete(row.name)}
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
  );
}
