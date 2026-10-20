import { describe, expect, it } from 'vitest'
import { LINK, REFUSED_LINK, registryValue } from '../smoke-orivon-link.mjs'
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
