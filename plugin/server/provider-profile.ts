import type { PaseoProviderSnapshotResult } from '@getpaseo/client';

// Keep only provider selection data needed by the host picker. Do not export
// provider errors, arbitrary model metadata, or unknown plugin-defined fields.
export function providerProfile(snapshot: PaseoProviderSnapshotResult, selected: string[]) {
  const providers = new Set<string>();
  if (selected.includes('codex-login') || selected.includes('openai-key')) providers.add('codex');
  if (selected.includes('anthropic-key')) providers.add('claude');
  if (selected.includes('gemini-key')) providers.add('gemini');
  return snapshot.entries.filter(entry => providers.has(entry.provider)).map(entry => ({
    provider: entry.provider,
    status: entry.status,
    enabled: entry.enabled,
    label: entry.label,
    defaultModeId: entry.defaultModeId,
    models: entry.models?.map(model => ({
      provider: model.provider, id: model.id, label: model.label,
      aliases: model.aliases, isSelectable: model.isSelectable, isDefault: model.isDefault,
      contextWindowMaxTokens: model.contextWindowMaxTokens,
      defaultThinkingOptionId: model.defaultThinkingOptionId,
      thinkingOptions: model.thinkingOptions?.map(option => ({id: option.id, label: option.label, isDefault: option.isDefault})),
    })),
    modes: entry.modes?.map(mode => ({id: mode.id, label: mode.label, icon: mode.icon, colorTier: mode.colorTier})),
  })).sort((a, b) => a.provider.localeCompare(b.provider));
}
