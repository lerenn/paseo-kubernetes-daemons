import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { WorkspaceScreen } from "./client/screen.js";
function Sidebar(props: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Boxes"
      label="Kubernetes Workspaces"
      active={props.currentScreen?.screenId === "workspaces"}
      onPress={() => props.openScreen({ screenId: "workspaces" })}
    />
  );
}
export default function contribute(client: PluginClientContext) {
  const screen = client.addScreen({
    id: "workspaces",
    title: "Kubernetes Workspaces",
    Component: WorkspaceScreen,
  });
  const sidebar = client.addSidebarHeaderItem({
    id: "workspaces",
    title: "Kubernetes Workspaces",
    Component: Sidebar,
  });
  return () => {
    sidebar();
    screen();
  };
}
