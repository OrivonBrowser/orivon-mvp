// What a local file's path holds in the ledger that nobody recorded or that was deleted: every grant, every picked path
// and a remembered refusal. Used before a file is asked about (`../install/local-file-grant.ts`) and when its data is deleted.
import type { Broker } from '../../broker/broker-contracts.js'
import type { CapabilityKind } from '../../contracts/index.js'

/**
 * Revokes every grant and picked path the ledger keeps for `key`, and forgets a declined question, so that a path nobody
 * recorded starts with nothing. Revoking a persisted grant drops the live one and its handles too.
 */
export async function dropLocalFileGrants (broker: Broker, key: string): Promise<void> {
  const persisted = broker.app.persistedAppsSync().find((app) => app.origin === key)
  for (const capability of Object.keys(persisted?.grants ?? {})) await broker.revokePersisted(key, capability as CapabilityKind)
  for (const pickId of Object.keys(persisted?.pickedPaths ?? {})) await broker.revokeUserSelectedPath(key, pickId)
  await broker.clearDeclinedConsent(key)
}
