import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isProfileFolder, readRegistry, slotDirOf, writeRegistry } from '../registry-runner.js'

async function withTempDir (fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-registry-runner-test-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('readRegistry: a corrupt registry.json', () => {
  it('is moved aside, logged once, and read back as an empty registry -- never silently overwritten by the next write', async () => {
    await withTempDir(async (userDataPath) => {
      const extensionsDir = join(userDataPath, 'extensions')
      mkdirSync(extensionsDir, { recursive: true })
      const registryPath = join(extensionsDir, 'registry.json')
      writeFileSync(registryPath, '{ this is not valid json')

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const entries = readRegistry(userDataPath)
      expect(entries).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      const asidePathMessage = String(warn.mock.calls[0]?.[0])
      expect(asidePathMessage).toContain('registry.json.corrupt-')
      warn.mockRestore()

      expect(existsSync(registryPath)).toBe(false)
      const siblings = readdirSync(extensionsDir)
      const corruptName = siblings.find((name) => name.startsWith('registry.json.corrupt-'))
      expect(corruptName).toBeDefined()
      expect(readFileSync(join(extensionsDir, corruptName as string), 'utf8')).toBe('{ this is not valid json')

      // The corrupt file is never read again on a later boot, and a write
      // afterward creates a fresh registry.json rather than touching it.
      writeRegistry(userDataPath, [])
      expect(existsSync(registryPath)).toBe(true)
      expect(readdirSync(extensionsDir).filter((name) => name.startsWith('registry.json.corrupt-'))).toEqual([corruptName])
    })
  })

  it('a well-formed but shape-invalid registry.json is moved aside the same way', async () => {
    await withTempDir(async (userDataPath) => {
      const extensionsDir = join(userDataPath, 'extensions')
      mkdirSync(extensionsDir, { recursive: true })
      const registryPath = join(extensionsDir, 'registry.json')
      writeFileSync(registryPath, JSON.stringify({ extensions: [{ id: 'missing-every-other-field' }] }))

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const entries = readRegistry(userDataPath)
      warn.mockRestore()

      expect(entries).toEqual([])
      expect(existsSync(registryPath)).toBe(false)
      expect(readdirSync(extensionsDir).some((name) => name.startsWith('registry.json.corrupt-'))).toBe(true)
    })
  })

  it('a missing registry.json still reads as [] with no rename and no warning', async () => {
    await withTempDir(async (userDataPath) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const entries = readRegistry(userDataPath)
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
      expect(entries).toEqual([])
    })
  })

  it('a well-formed, empty registry.json reads back with no warning and no rename', async () => {
    await withTempDir(async (userDataPath) => {
      writeRegistry(userDataPath, [])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const entries = readRegistry(userDataPath)
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
      expect(entries).toEqual([])
      expect(existsSync(join(userDataPath, 'extensions', 'registry.json'))).toBe(true)
    })
  })
})

describe('slotDirOf', () => {
  const userData = join(tmpdir(), 'orivon-slot-test')
  const extensions = join(userData, 'extensions')

  it('is the folder above the loaded version for an extension installed into the profile', () => {
    const path = join(extensions, 'an-id', '1.0.0')
    expect(slotDirOf(userData, 'an-id', path)).toBe(join(extensions, 'an-id'))
    expect(slotDirOf(userData, 'an-id', path, { kind: 'file', fileName: 'x.crx' })).toBe(join(extensions, 'an-id'))
  })

  it('is the folder of its id for an extension loaded from the application, and not for one that is merely spelled elsewhere', () => {
    const app = join(tmpdir(), 'app', 'default-profile', 'extensions', 'ublock-origin')
    expect(slotDirOf(userData, 'an-id', app)).toBe(join(extensions, 'an-id'))
    expect(slotDirOf(userData, 'an-id', app, { kind: 'bundled', folder: 'ublock-origin' })).toBe(join(extensions, 'an-id'))
    const spelledElsewhere = join(tmpdir(), 'link-to-profile', 'extensions', 'u-abc', '1.0.0')
    expect(slotDirOf(userData, 'an-id', spelledElsewhere, { kind: 'file', fileName: 'x.crx' })).toBe(join(tmpdir(), 'link-to-profile', 'extensions', 'u-abc'))
  })

  it('names as the profile\'s own only what is inside its extensions folder', () => {
    expect(isProfileFolder(userData, join(extensions, 'a', '1'))).toBe(true)
    expect(isProfileFolder(userData, extensions)).toBe(false)
    expect(isProfileFolder(userData, join(userData, 'elsewhere'))).toBe(false)
    expect(isProfileFolder(userData, join(extensions, '..', 'elsewhere'))).toBe(false)
  })
})
