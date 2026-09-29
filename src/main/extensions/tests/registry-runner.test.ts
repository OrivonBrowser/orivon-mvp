import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readRegistry, writeRegistry } from '../registry-runner.js'

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
