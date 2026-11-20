import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export const resourceName = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
export const bundleSchema = z.object({
  name: resourceName,
  scope: z.string(),
  syncedAt: z.string(),
  providers: z.array(z.string()),
  mcps: z.array(z.string()),
  repository: z.string(),
  gatewayReady: z.boolean().default(false),
});
// Keep in step with plugin/package.json: releases publish paseo-workspace:<version>.
export const DEFAULT_WORKSPACE_IMAGE = "ghcr.io/lerenn/paseo-workspace:0.2.0";
export const settingsSchema = z.object({
  context: z.string().max(200).default(""),
  namespace: resourceName.default("paseo-workspaces"),
  clusterId: z.string().min(1).max(100).default("default"),
  image: z.string().max(500).default(DEFAULT_WORKSPACE_IMAGE),
  mainConnection: z.string().max(1000).default(""),
  docker: z.boolean().default(false),
  ephemeral: z.boolean().default(true),
  bundle: bundleSchema.nullable().default(null),
});
export type Configuration = z.output<typeof settingsSchema>;
export const workspaceSettings = defineSettings({
  id: "workspace-setup",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
export function scopeOf(c: Configuration) {
  return JSON.stringify([c.context, c.clusterId, c.namespace]);
}
