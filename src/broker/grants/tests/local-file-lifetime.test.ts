import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCAL_DATA_DIR, derivationScope, localDataBase, localDataRoot, runId } from '../local-file-lifetime.js'
import { appDataRoot, originHash } from '../origin-hash.js'

const FILE = 'file:///home/u/app/index.html'
const WEB = 'https://app.example'

describe('derivationScope', () => {
  it('is the key itself for a web origin, in every run', () => {
    expect(derivationScope(WEB, 'run-a')).toBe(WEB)
    expect(derivationScope(WEB, 'run-b')).toBe(WEB)
  })

  it('differs between runs for a local file, and between files in one run', () => {
    expect(derivationScope(FILE, 'run-a')).not.toBe(derivationScope(FILE, 'run-b'))
    expect(derivationScope(FILE, 'run-a')).not.toBe(derivationScope('file:///home/u/app/other.html', 'run-a'))
  })

  it('is stable within a run and never equals a web origin', () => {
    expect(derivationScope(FILE, 'run-a')).toBe(derivationScope(FILE, 'run-a'))
    expect(derivationScope(FILE, 'run-a')).not.toBe(FILE)
  })

  it('uses this run\'s own id by default', () => {
    expect(derivationScope(FILE)).toBe(derivationScope(FILE, runId()))
    expect(runId()).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('localDataRoot', () => {
  it('is under app-data-local/<run>/<hash>, never the key string', () => {
    const root = localDataRoot('/u', originHash(FILE), 'run-a')
    expect(root).toBe(join('/u', LOCAL_DATA_DIR, 'run-a', originHash(FILE)))
    expect(root).not.toContain('index.html')
  })

  it('sits outside app-data/, so the sweep never touches an app\'s persisted files', () => {
    expect(localDataBase('/u')).toBe(join('/u', LOCAL_DATA_DIR))
    expect(localDataBase('/u').startsWith(join('/u', 'app-data') + sep)).toBe(false)
  })
})

describe('appDataRoot for a local file', () => {
  it('routes a file key to the per-run local tree and a web origin to app-data/', () => {
    expect(appDataRoot('/u', WEB)).toBe(join('/u', 'app-data', originHash(WEB)))
    expect(appDataRoot('/u', FILE)).toBe(join('/u', LOCAL_DATA_DIR, runId(), originHash(FILE)))
  })
})
