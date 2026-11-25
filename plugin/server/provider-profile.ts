import type { PaseoApi, PaseoProviderSnapshotResult } from '@getpaseo/client';

// Keep only provider selection data needed by the host picker. Do not export
// provider errors, arbitrary model metadata, or unknown plugin-defined fields.
export function providerProfile(snapshot: PaseoProviderSnapshotResult, selected: string[]) {
  const providers = new Set<string>();
  if (selected.includes('codex-login') || selected.includes('openai-key')) providers.add('codex');
  if (selected.includes('anthropic-key')) providers.add('claude');
  if (selected.includes('gemini-key')) providers.add('gemini');
  // A selected provider profile appears under its own id, with its own label and models.
  for (const ref of selected) if (ref.startsWith('profile:')) providers.add(ref.slice('profile:'.length));
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

export async function captureControls(paseo: PaseoApi, snapshot: PaseoProviderSnapshotResult, selected: string[], cwd: string) {
  const result: Record<string, unknown> = {};
  for (const entry of providerProfile(snapshot, selected)) {
    const models = [...new Set(entry.models?.filter(m => m.isSelectable !== false).map(m => m.id) ?? [])];
    if (models.length > 100) throw new Error('Provider model catalog exceeds the sync limit.');
    for (const model of models) {
      const value = await paseo.providers.listControls({provider: `${entry.provider}/${model}`, cwd});
      if (value.error) throw new Error('Provider controls are unavailable. Refresh provider discovery before syncing.');
      result[JSON.stringify([entry.provider, model])] = (value.controls ?? []).map(control => ({
        type: control.type, key: control.key, label: control.label, description: control.description,
        tooltip: control.tooltip, icon: control.icon, defaultValue: control.defaultValue,
        ...(control.type === 'select' ? {choices: control.choices.map(choice => ({value: choice.value, label: choice.label, description: choice.description})), desktopTrigger: control.desktopTrigger} : {}),
      }));
    }
    const defaultModel = entry.models?.find(model => model.isDefault)?.id ?? models[0];
    if(defaultModel) result[JSON.stringify([entry.provider, ''])] = result[JSON.stringify([entry.provider, defaultModel])];
  }
  return result;
}
