// test:changed reads package.json electron.vite.config.ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import config, { root } from '../../electron.vite.config.js'

interface Manifest {
  readonly dependencies?: Record<string, string>
  readonly devDependencies?: Record<string, string>
  readonly orivon?: { readonly shimPackages?: readonly string[] }
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest

describe('a package carries no node_modules', () => {
  it('bundles every dependency of the main process into its entries', () => {
    expect(config.main?.build?.externalizeDeps).toBe(false)
  })

  it('lists no production dependency, since electron-builder would copy it into app.asar', () => {
    expect(Object.keys(manifest.dependencies ?? {}), 'a library the main process or a page imports is bundled: put it in devDependencies').toEqual([])
  })

  it('installs every package the shim stands on', () => {
    const named = manifest.orivon?.shimPackages ?? []
    expect(named.length).toBeGreaterThan(0)
    for (const name of named) expect(manifest.devDependencies?.[name], name).toBeDefined()
  })
})
