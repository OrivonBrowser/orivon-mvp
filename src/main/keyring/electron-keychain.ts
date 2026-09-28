// The real, Electron-tied Keychain (ADR-0033) -- thin wiring over
// ./seed-store.ts's pure logic and Electron's own `safeStorage`. This file
// is the one piece of ../../broker/secrets-contracts.js's `Keychain` this
// repository cannot test without a real Electron process; see
// seed-store.test.ts for everything this file does not need to repeat.

import { join } from 'node:path'
import { safeStorage } from 'electron'
import { SeedStore } from './seed-store.js'
import type { SafeStorageLike } from './seed-store.js'
import type { Keychain } from '../../broker/secrets-contracts.js'

/** The one keychain of this process, for Settings to say whether the identity key is kept: it is made by the broker at start. */
let current: Keychain | undefined

/** Where the identity key lives: `keychain` when an OS keyring holds it, `session-only` when it is remade on every start (no
 * keyring, or a private session), `not-started` before the broker has made one. */
export async function identityKeyStorage (): Promise<'keychain' | 'session-only' | 'not-started'> {
  if (current === undefined) return 'not-started'
  return (await current.isPersistent?.()) === true ? 'keychain' : 'session-only'
}

/**
 * One store per Electron process, under `<userData>/identity/seed.json` --
 * a sibling of `<userData>/grants/` and `<userData>/bookmarks.json`
 * (ADR-0003's own tiers), never inside `apps/<origin>/`, because this is
 * BROWSER SECRET, not app-owned, data.
 */
export function createElectronKeychain (userDataPath: string, storage: SafeStorageLike = safeStorage): Keychain {
  const store = new SeedStore(join(userDataPath, 'identity', 'seed.json'), storage)

  const keychain: Keychain = {
    async getSeed () {
      return (await store.resolve()).seed
    },
    async isPersistent () {
      return (await store.resolve()).persistent
    }
  }
  current = keychain
  return keychain
}
