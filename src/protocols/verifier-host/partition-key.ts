// The key a partition goes by in the IPFS node's store: base64url of
// sha256(salt || partition), 43 characters. The salt is per profile and goes
// nowhere but here (HostConfig), so the node's database holds no origin in
// plain text, and a database copied from one profile means nothing in another.

import { createHash } from 'node:crypto'

export function partitionStoreKey (saltHex: string, partition: string): string {
  return createHash('sha256').update(Buffer.from(saltHex, 'hex')).update(partition).digest('base64url')
}
