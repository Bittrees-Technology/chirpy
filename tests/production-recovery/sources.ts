type SourceId = 'governance' | 'research';
const definitions = {
  governance: {id: 'governance', label: 'Governance', origin: 'https://gov.bittrees.org', path: '/messenger', hashVariable: 'GOV_EXPECTED_ASSET_SHA'},
  research: {id: 'research', label: 'Research', origin: 'https://research.bittrees.org', path: '/chat-recovery', hashVariable: 'RESEARCH_EXPECTED_ASSET_SHA'},
} as const;

/** Explicit live acceptance only; each selected source must have reviewed version evidence. */
export function recoverySources() {
  if (process.env.CHAT_PRODUCTION_RECOVERY_ACCEPTANCE !== '1' || !/^[a-f0-9]{40}$/.test(process.env.CHAT_EXPECTED_SHA ?? '')) {
    throw Error('Explicit recovery acceptance activation and full reviewed Chat commit are required.');
  }
  const selection = process.env.CHAT_RECOVERY_SOURCE ?? 'governance';
  if (!['governance', 'research', 'all'].includes(selection)) throw Error('CHAT_RECOVERY_SOURCE must be governance, research or all.');
  const ids: SourceId[] = selection === 'all' ? ['governance', 'research'] : [selection as SourceId];
  return ids.map(id => {
    const source = definitions[id], assetHash = process.env[source.hashVariable];
    if (!/^[a-f0-9]{64}$/.test(assetHash ?? '')) throw Error(`A reviewed ${source.label} main-module SHA256 is required in ${source.hashVariable}.`);
    return {...source, assetHash: assetHash!};
  });
}
