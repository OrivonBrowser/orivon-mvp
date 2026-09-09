import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildAliasEntries, SHIM_MODULE_MAP } from '../module-map.js'

// Every 'local' implementation path is resolved from here (src/shim/tests/),
// one directory below src/shim/ itself -- matching how electron.vite.config.ts
// resolves the same paths from src/shim/, so a typo here is a typo there too.
const shimDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

// The floor this stream was dispatched to close (compatibility-matrix.md
// Table 3's six, plus zlib/util from freetube-port-recon.md's correction 1),
// plus 'electron' -- a sibling stream's alias entry this stream owns the map
// for. A row silently disappearing from the table should fail a test, not
// wait for someone to notice compatibility-matrix.md and the tree disagree.
const FLOOR_SPECIFIERS = ['buffer', 'stream', 'events', 'path', 'os', 'crypto', 'zlib', 'util', 'electron']

describe('SHIM_MODULE_MAP', () => {
  it('carries every floor specifier from the compatibility matrix and the recon correction', () => {
    const specifiers = SHIM_MODULE_MAP.map((entry) => entry.specifier)
    for (const floor of FLOOR_SPECIFIERS) expect(specifiers).toContain(floor)
  })

  it('never lists the same specifier twice', () => {
    const specifiers = SHIM_MODULE_MAP.map((entry) => entry.specifier)
    expect(new Set(specifiers).size).toBe(specifiers.length)
  })

  it('gives every entry a non-empty note explaining its status', () => {
    for (const entry of SHIM_MODULE_MAP) expect(entry.note.length).toBeGreaterThan(0)
  })

  it('every "ready" entry names its implementation and kind', () => {
    for (const entry of SHIM_MODULE_MAP) {
      if (entry.status !== 'ready') continue
      expect(entry.kind).toBeDefined()
      expect(entry.implementation).toBeDefined()
    }
  })

  it('every "ready", "local" entry points at a file that actually exists', () => {
    for (const entry of SHIM_MODULE_MAP) {
      if (entry.status !== 'ready' || entry.kind !== 'local') continue
      // Entries name the built '.js' specifier (NodeNext-style, matching
      // every relative import elsewhere in this directory); the source on
      // disk is '.ts'.
      const sourcePath = (entry.implementation as string).replace(/\.js$/, '.ts')
      const path = resolve(shimDir, sourcePath)
      expect(existsSync(path), `${entry.specifier} -> ${path}`).toBe(true)
    }
  })
})

describe('buildAliasEntries', () => {
  it('includes every "ready" specifier and excludes every "pending-dependency" one', () => {
    const entries = buildAliasEntries()
    const bySpecifier = new Map(entries.map((entry) => [entry.specifier, entry]))

    for (const entry of SHIM_MODULE_MAP) {
      if (entry.status === 'ready') expect(bySpecifier.has(entry.specifier)).toBe(true)
      else expect(bySpecifier.has(entry.specifier)).toBe(false)
    }
  })

  it("resolves 'electron' to the sibling shim-electron package, closing A106", () => {
    const entries = buildAliasEntries()
    const electron = entries.find((entry) => entry.specifier === 'electron')
    expect(electron).toEqual({ specifier: 'electron', kind: 'local', implementation: '../shim-electron/index.js' })
  })

  it("resolves 'util' to this stream's own hand-written inherits-only shim", () => {
    const entries = buildAliasEntries()
    const util = entries.find((entry) => entry.specifier === 'util')
    expect(util).toEqual({ specifier: 'util', kind: 'local', implementation: './node-util.js' })
  })
})
