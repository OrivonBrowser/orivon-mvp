// The real, node:fs-backed LedgerStorage -- ledger-storage.ts's own header
// explains why this is synchronous rather than following LoaderStorage's
// async, node:fs/promises pattern.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { originHash } from './origin-hash.js'
import type { LedgerStorage } from './ledger-storage.js'

/**
 * Never valid semver (no digits, no dots) -- returned for anything that
 * exists on disk but is not a clean `{ versionFloor: string }`. GrantLedger
 * detects this via compareVersions returning null and fails every future
 * update closed rather than silently treating it as '0.0.0' (T19).
 */
const CORRUPT_FLOOR_SENTINEL = 'unreadable-or-corrupt-version-floor'

function floorDir (userDataPath: string, origin: string): string {
  return join(userDataPath, 'grants', originHash(origin))
}

function floorPath (userDataPath: string, origin: string): string {
  return join(floorDir(userDataPath, origin), 'version-floor.json')
}

function isVersionFloorShape (value: unknown): value is { versionFloor: string } {
  return typeof value === 'object' && value !== null &&
    typeof (value as { versionFloor?: unknown }).versionFloor === 'string'
}

export function nodeLedgerStorage (userDataPath: string): LedgerStorage {
  return {
    readVersionFloor: (origin) => {
      let text: string
      try {
        text = readFileSync(floorPath(userDataPath, origin), 'utf8')
      } catch (error) {
        // ENOENT alone means "never persisted" -- the one case GrantLedger
        // may treat as having nothing to hydrate. Any OTHER read failure
        // (permissions, a mid-write crash) must not collapse into that same
        // undefined, for the reason ledger-storage.ts's own doc explains.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        return CORRUPT_FLOOR_SENTINEL
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return CORRUPT_FLOOR_SENTINEL
      }
      return isVersionFloorShape(parsed) ? parsed.versionFloor : CORRUPT_FLOOR_SENTINEL
    },
    writeVersionFloor: (origin, versionFloor) => {
      mkdirSync(floorDir(userDataPath, origin), { recursive: true })
      writeFileSync(floorPath(userDataPath, origin), JSON.stringify({ versionFloor }))
    }
  }
}
