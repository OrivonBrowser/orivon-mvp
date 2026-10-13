// Test builds only: a directory holding a stand-in for the Nym module, named by ORIVON_TEST_NYM_MODULE, run in
// place of the pinned one. Its files are hashed here so the host's check passes for them; gated on the same
// compiled-in flag as the developer grant (../dev/dev-grant.ts), so an ordinary build carries none of it, which
// scripts/check-dev-grant-absent.mjs proves by looking for the variable's name in the output.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PinnedFile } from '../../protocols/nym-tunnel/protocol.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

export interface NymTestModule {
  readonly directory: string
  readonly files: readonly PinnedFile[]
}

export function nymTestModule (env: Readonly<Record<string, string | undefined>>): NymTestModule | undefined {
  const directory = SEAM_ENABLED ? env['ORIVON_TEST_NYM_MODULE'] : undefined
  if (directory === undefined || directory === '') return undefined
  const files = readdirSync(directory).sort().map((name): PinnedFile => {
    const bytes = readFileSync(join(directory, name))
    return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  return { directory, files }
}
