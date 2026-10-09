// Takes back everything an origin holds: the answer to files that are not the ones the site declared.
// Built on the broker's per-capability revoke, which also closes the handles a grant authorised.

import type { Broker } from '../../broker/broker-contracts.js'

/**
 * Revokes every grant of `origin`, registered or not. A removal that fails does not stop the others;
 * the rejection afterwards names the capabilities that were left, because a caller that blocked an
 * app for its files must not report a clean slate it does not have.
 */
export async function revokeAllGrants (broker: Pick<Broker, 'app' | 'revokePersisted'>, origin: string): Promise<void> {
  const left: string[] = []
  for (const { capability } of await broker.app.grants(origin)) {
    try {
      await broker.revokePersisted(origin, capability)
    } catch (error) {
      console.error('[first-visit] a grant could not be revoked', origin, capability, error)
      left.push(capability)
    }
  }
  if (left.length > 0) throw new Error(`could not revoke ${left.join(', ')} for ${origin}`)
}
