// Verifies test/apps/fixture/.well-known/orivon.json against the real validator
// (src/loader/manifest/manifest.ts's parseManifest) rather than hand-rolling a second
// check of the same rules (code-guidelines.md Rule 3). Also checks that the
// manifest's one declared net.connect pattern matches config.mjs's
// ECHO_PORT/HOST exactly, since a static JSON file cannot import the
// constants it must stay in sync with.
//
// No runner picks this file up. vitest.config.ts's include is `src/**/*.test.ts`
// and `scripts/**/*.test.ts`; test/vitest.e2e.config.ts excludes `test/apps/**`,
// deliberately, so a pure validator check with no Electron and no servers does
// not sit behind an e2e build. **Provisional:** adding `test/apps/**/*.test.ts`
// to vitest.config.ts's include would run it under `npm test`, which is what
// would settle this.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseManifest } from '../../../src/loader/manifest/manifest.js'
import { ECHO_PORT, HOST } from './config.mjs'

const MANIFEST_PATH = fileURLToPath(new URL('./.well-known/orivon.json', import.meta.url))

function readManifestText (): string {
  return readFileSync(MANIFEST_PATH, 'utf8')
}

describe('test/apps/fixture/.well-known/orivon.json', () => {
  it('is accepted by parseManifest', () => {
    const result = parseManifest(readManifestText())
    expect(result.ok).toBe(true)
  })

  it('declares exactly one net.connect pattern, scoped to the echo server -- not a wildcard', () => {
    const result = parseManifest(readManifestText())
    if (!result.ok) throw new Error(`manifest rejected: ${result.reason}`)

    expect(result.manifest.capabilities.net?.tcp?.connect).toEqual([`${HOST}:${ECHO_PORT}`])
    expect(result.manifest.capabilities.net?.tcp?.listen).toBeUndefined()
    expect(result.manifest.capabilities.net?.udp).toBeUndefined()
    expect(result.manifest.capabilities.fs).toBeUndefined()
    expect(result.manifest.capabilities.id).toBeUndefined()
    expect(result.manifest.capabilities.protocols).toBeUndefined()
  })

  it('entry points at a file this app actually serves', () => {
    const result = parseManifest(readManifestText())
    if (!result.ok) throw new Error(`manifest rejected: ${result.reason}`)
    expect(result.manifest.entry).toBe('index.html')
  })
})
