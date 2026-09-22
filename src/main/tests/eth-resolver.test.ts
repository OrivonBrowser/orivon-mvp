import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const appendSwitch = vi.fn()

vi.mock('electron', () => ({
  app: { commandLine: { appendSwitch } }
}))

const { buildHostResolverRules, ethResolverSubsystem } = await import('../eth-resolver.js')

describe('buildHostResolverRules', () => {
  it('builds one MAP clause per name, to its own port', () => {
    expect(buildHostResolverRules({ 'freetube.eth': 8875, 'asgardex.eth': 8876 }))
      .toBe('MAP freetube.eth 127.0.0.1:8875,MAP asgardex.eth 127.0.0.1:8876')
  })

  it('is empty for an empty map', () => {
    expect(buildHostResolverRules({})).toBe('')
  })

  // Appended verbatim to a command-line switch -- a key or value that is not
  // exactly this shape is dropped rather than trusted, since this file
  // reads a names map from OUTSIDE this process.
  it('drops a name that is not a plain "label.eth"', () => {
    for (const bad of ['freetube', 'FreeTube.eth', 'sub.freetube.eth', 'freetube.com', 'freetube.eth,MAP evil.com 1.2.3.4:80']) {
      expect(buildHostResolverRules({ [bad]: 8875 })).toBe('')
    }
  })

  it('drops a non-integer, out-of-range, or non-numeric port', () => {
    for (const bad of [0, -1, 65536, 8875.5, Number.NaN]) {
      expect(buildHostResolverRules({ 'freetube.eth': bad })).toBe('')
    }
    expect(buildHostResolverRules({ 'freetube.eth': '8875' as unknown as number })).toBe('')
  })

  it('keeps the valid entries and drops only the bad ones', () => {
    expect(buildHostResolverRules({ 'freetube.eth': 8875, 'Bad.eth': 1, 'asgardex.eth': 8876 }))
      .toBe('MAP freetube.eth 127.0.0.1:8875,MAP asgardex.eth 127.0.0.1:8876')
  })
})

describe('ethResolverSubsystem', () => {
  let dir: string
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-eth-resolver-'))
    appendSwitch.mockClear()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    process.env = { ...ORIGINAL_ENV }
  })

  const namesFile = (content: string): string => {
    const path = join(dir, 'names.json')
    writeFileSync(path, content)
    return path
  }

  it('does nothing when ORIVON_DEV_ORIGINS is not set, even with a valid file', () => {
    delete process.env['ORIVON_DEV_ORIGINS']
    process.env['ORIVON_ETH_NAMES_FILE'] = namesFile('{"freetube.eth": 8875}')
    ethResolverSubsystem.beforeReady?.()
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it('does nothing when ORIVON_ETH_NAMES_FILE is not set, even in dev mode', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    delete process.env['ORIVON_ETH_NAMES_FILE']
    ethResolverSubsystem.beforeReady?.()
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it('appends host-resolver-rules from a valid file, both flags set', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_ETH_NAMES_FILE'] = namesFile('{"freetube.eth": 8875, "asgardex.eth": 8876}')
    ethResolverSubsystem.beforeReady?.()
    expect(appendSwitch).toHaveBeenCalledWith(
      'host-resolver-rules',
      'MAP freetube.eth 127.0.0.1:8875,MAP asgardex.eth 127.0.0.1:8876'
    )
  })

  it('does not append anything for an empty names file', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_ETH_NAMES_FILE'] = namesFile('{}')
    ethResolverSubsystem.beforeReady?.()
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  // A missing or malformed file is a dev mistake, not a reason to crash the
  // shell -- console.error is enough, and this proves that path does not
  // throw out of beforeReady.
  it('does not throw on a missing file, and appends nothing', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_ETH_NAMES_FILE'] = join(dir, 'does-not-exist.json')
    expect(() => ethResolverSubsystem.beforeReady?.()).not.toThrow()
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it('does not throw on malformed JSON, or JSON that is not an object map', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    for (const content of ['not json', '[1, 2, 3]', '"a string"', 'null']) {
      process.env['ORIVON_ETH_NAMES_FILE'] = namesFile(content)
      expect(() => ethResolverSubsystem.beforeReady?.()).not.toThrow()
    }
    expect(appendSwitch).not.toHaveBeenCalled()
  })
})
