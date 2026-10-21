// The secret the SOCKS5 user names are made under (`../../broker/route/socks5.ts`'s `isolationCredentials`): kept with the
// profile's other per-profile secret, the one the verifier keeps for the IPFS node's store keys, so a new profile has its own and
// clearing browsing data replaces it. If it cannot be read or made, the names last for the run only.

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { VerifierStore } from '../verifier/verifier-store.js'

export function profileIsolationSecret (userData: string): Uint8Array {
  try {
    return Buffer.from(new VerifierStore(join(userData, 'verifier')).partitionSalt(), 'hex')
  } catch (error) {
    console.error('[route] could not read the profile\'s secret for the proxy user names; they last for this run only:', error)
    return randomBytes(32)
  }
}
