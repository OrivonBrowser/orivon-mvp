// node-builtin-exports.generated.json is a snapshot, not a live probe: CI's
// Node is not guaranteed to be the version it was written from, so this
// checks its SHAPE only and never diffs it against a fresh `require()`.
// Regenerate deliberately with ORIVON_WRITE_NODE_BUILTIN_EXPORTS=1 (a Node
// bump, or a new module-map.ts specifier).

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SHIM_MODULE_MAP } from '../module-map.js'

const GENERATED = fileURLToPath(new URL('../node-builtin-exports.generated.json', import.meta.url))

/** Every module-map.ts specifier with a real Node builtin behind it -- 'electron' is the one row naming a different package entirely. */
const NODE_SPECIFIERS = SHIM_MODULE_MAP.map((entry) => entry.specifier).filter((specifier) => specifier !== 'electron')

interface RawExports { nodeVersion: string, modules: Record<string, { functions: string[], data: string[] }> }

async function collectFreshExports (): Promise<RawExports> {
  const modules: RawExports['modules'] = {}
  for (const specifier of NODE_SPECIFIERS) {
    const mod = await import(/* @vite-ignore */ `node:${specifier}`) as Record<string, unknown>
    const keys = Object.keys(mod).sort()
    modules[specifier] = {
      functions: keys.filter((key) => typeof mod[key] === 'function'),
      data: keys.filter((key) => typeof mod[key] !== 'function')
    }
  }
  return { nodeVersion: process.versions.node, modules }
}

it('node-builtin-exports.generated.json names every module-map.ts specifier, sorted and non-overlapping', async () => {
  if (process.env.ORIVON_WRITE_NODE_BUILTIN_EXPORTS === '1') {
    writeFileSync(GENERATED, `${JSON.stringify(await collectFreshExports(), null, 2)}\n`)
  }
  const onDisk = JSON.parse(readFileSync(GENERATED, 'utf8')) as RawExports
  expect(onDisk.nodeVersion).toMatch(/^\d+\.\d+\.\d+$/)
  expect(Object.keys(onDisk.modules).sort()).toEqual([...NODE_SPECIFIERS].sort())
  for (const specifier of NODE_SPECIFIERS) {
    const entry = onDisk.modules[specifier]
    if (entry === undefined) { expect.fail(`${specifier} is recorded`); continue }
    expect(entry.functions, `${specifier}.functions is sorted`).toEqual([...entry.functions].sort())
    expect(entry.data, `${specifier}.data is sorted`).toEqual([...entry.data].sort())
    const overlap = entry.functions.filter((name) => entry.data.includes(name))
    expect(overlap, `${specifier} names one member as both callable and data`).toEqual([])
  }
}, 30_000)
