// Verifies apps/fixture/.well-known/orivon.json against the real validator
// (src/loader/manifest.ts's parseManifest) rather than hand-rolling a second
// check of the same rules (code-guidelines.md Rule 3). Also checks that the
// manifest's one declared net.connect pattern matches config.mjs's
// ECHO_PORT/HOST exactly, since a static JSON file cannot import the
// constants it must stay in sync with.
//
// NOT PICKED UP BY `npm test` YET. vitest.config.ts's include pattern is
// `src/**/*.test.ts` and `scripts/**/*.test.ts`; apps/fixture/ is neither.
// Run directly with `npx vitest run apps/fixture/manifest.test.ts` until
// that is decided -- see lanes/fixture-01-app/log.md's QUESTION checkpoint.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseManifest } from '../../src/loader/manifest.js'
import { ECHO_PORT, HOST } from './config.mjs'

const MANIFEST_PATH = fileURLToPath(new URL('./.well-known/orivon.json', import.meta.url))

function readManifestText (): string {
  return readFileSync(MANIFEST_PATH, 'utf8')
}

describe('apps/fixture/.well-known/orivon.json', () => {
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
