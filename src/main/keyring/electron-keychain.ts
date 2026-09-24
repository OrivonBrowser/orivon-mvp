// The real, Electron-tied Keychain (ADR-0031) -- thin wiring over
// ./seed-store.ts's pure logic and Electron's own `safeStorage`. This file
// is the one piece of ../../broker/secrets-contracts.js's `Keychain` this
// repository cannot test without a real Electron process; see
// seed-store.test.ts for everything this file does not need to repeat.

import { join } from 'node:path'
import { safeStorage } from 'electron'
import { SeedStore } from './seed-store.js'
import type { Keychain } from '../../broker/secrets-contracts.js'

/**
 * One store per Electron process, under `<userData>/identity/seed.json` --
 * a sibling of `<userData>/grants/` and `<userData>/bookmarks.json`
 * (ADR-0003's own tiers), never inside `apps/<origin>/`, because this is
 * BROWSER SECRET, not app-owned, data.
 */
export function createElectronKeychain (userDataPath: string): Keychain {
  const store = new SeedStore(join(userDataPath, 'identity', 'seed.json'), safeStorage)

  return {
    async getSeed () {
      return (await store.resolve()).seed
    },
    async isPersistent () {
      return (await store.resolve()).persistent
    }
  }
}
