import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PaseoProviderSnapshotResult } from '@getpaseo/client';
import { providerProfile } from './provider-profile.js';

test('exports only selected model discovery fields and drops arbitrary metadata', () => {
  const snapshot = {entries:[
    {provider:'codex', status:'ready', error:'PRIVATE_ERROR', models:[{provider:'codex',id:'model',label:'Model',metadata:{token:'PRIVATE_TOKEN'},thinkingOptions:[{id:'high',label:'High',description:'PRIVATE_DESCRIPTION'}]}]},
    {provider:'claude', status:'ready', models:[{provider:'claude',id:'other',label:'Other'}]},
  ]} as unknown as PaseoProviderSnapshotResult;
  const result = providerProfile(snapshot,['codex-login']);
  assert.deepEqual(result.map(entry => entry.provider),['codex']);
  assert.equal(result[0].models?.[0].id,'model');
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
});
