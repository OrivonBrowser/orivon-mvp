import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LINK, REFUSED_LINK, execProgram, linuxChecks, registryValue } from '../smoke-orivon-link.mjs'
import { parseOrivonLink } from '../../src/main/launch/orivon-link.js'

describe('registryValue', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\orivon\\shell\\open\\command',
    '    (Default)    REG_SZ    "C:\\Users\\x\\AppData\\Local\\Programs\\Orivon\\Orivon.exe" -- "%1"',
    '    URL Protocol    REG_SZ    ',
    '    Orivon    REG_SZ    Software\\Clients\\StartMenuInternet\\Orivon\\Capabilities',
    ''
  ].join('\r\n')

  it('reads a named value, the default value and an empty string', () => {
    expect(registryValue(output, 'Orivon')).toBe('Software\\Clients\\StartMenuInternet\\Orivon\\Capabilities')
    expect(registryValue(output, '')).toBe('"C:\\Users\\x\\AppData\\Local\\Programs\\Orivon\\Orivon.exe" -- "%1"')
    expect(registryValue(output, 'URL Protocol')).toBe('')
  })

  it('is undefined for a value that is not listed', () => {
    expect(registryValue(output, 'Missing')).toBeUndefined()
    expect(registryValue('ERROR: The system was unable to find the specified registry key or value.', 'Orivon')).toBeUndefined()
  })
})

describe('the links the probe hands to the system', () => {
  it('are one the app opens and one it refuses', () => {
    expect(parseOrivonLink(LINK)).toEqual({ target: 'orivon-link-smoke.eth/page' })
    expect(parseOrivonLink(REFUSED_LINK)).toBeUndefined()
  })
})

describe('execProgram', () => {
  it.each([
    ['/opt/Orivon/orivon %U', '/opt/Orivon/orivon'],
    ['"/home/a b/.local/lib/orivon/orivon" %U', '/home/a b/.local/lib/orivon/orivon'],
    ['"/odd \\"name\\"/orivon" %U', '/odd "name"/orivon'],
    ['orivon', 'orivon']
  ])('reads the program of %s', (exec, program) => {
    expect(execProgram(exec)).toBe(program)
  })
})

const has = (tool: string): boolean => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0

describe.skipIf(!has('xdg-mime'))('the Linux registration check', () => {
  const INSTALLED = '/home/someone/.local/lib/orivon/orivon'
  let root: string
  let share: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orivon-link-smoke-'))
    share = join(root, 'share')
    mkdirSync(join(share, 'applications'), { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** Reads the folders under the scratch root and nothing else: the system's entries and the person's are out of reach. */
  const confined = (): Record<string, string> => ({ PATH: process.env['PATH'] ?? '', HOME: root, XDG_DATA_HOME: share, XDG_DATA_DIRS: share, XDG_CONFIG_HOME: join(root, 'config'), XDG_CONFIG_DIRS: join(root, 'config') })
  const entry = (file: string, program: string, schemes: string[]): void => {
    const types = ['text/html', ...schemes.map((scheme) => `x-scheme-handler/${scheme}`)]
    writeFileSync(join(share, 'applications', file), `[Desktop Entry]\nName=Orivon Browser\nExec="${program}" %U\nType=Application\nMimeType=${types.join(';')};\n`)
  }
  const failed = (): string[] => linuxChecks(INSTALLED, confined()).filter((check) => !check.ok).map((check) => check.name)

  it('fails when the entry lists http and https and not orivon', () => {
    entry('orivon.desktop', INSTALLED, ['http', 'https'])
    expect(failed()).toEqual(['the system hands orivon: links to a desktop entry', 'that entry starts the installed program', 'that entry lists http, https and orivon'])
  })

  it('passes when the entry lists all three and starts the installed program', () => {
    entry('orivon.desktop', INSTALLED, ['http', 'https', 'orivon'])
    expect(failed()).toEqual([])
  })

  it('fails when another program is the one the system hands the scheme to', () => {
    entry('other.desktop', '/usr/bin/other', ['orivon'])
    const checks = linuxChecks(INSTALLED, confined())
    expect(checks.filter((check) => !check.ok).map((check) => check.name)).toEqual(['that entry starts the installed program', 'that entry lists http, https and orivon'])
    expect(checks[1]?.detail).toContain('other.desktop')
  })

  it('fails when the entry that lists orivon lacks http', () => {
    entry('orivon.desktop', INSTALLED, ['https', 'orivon'])
    expect(failed()).toEqual(['that entry lists http, https and orivon'])
  })
})
