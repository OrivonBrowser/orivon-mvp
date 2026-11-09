import { describe, expect, it } from 'vitest'
import { parseWindowsSettings } from '../read-windows.js'
import type { WindowsRegistry } from '../read-windows.js'
import { blobHex, connectionBlob, internetSettings, perUserPolicy } from './reg-output.test-helpers.js'
import type { RegistryFixture } from './reg-output.test-helpers.js'

/** The blob of a fresh Windows user, as `reg query` printed it: detection on and nothing else. */
const FRESH_BLOB = '4600000002000000090000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000'

/** Printed on a computer whose Internet Options had a proxy for every scheme, `<local>` and one more exception. */
const SET_BY_INTERNET_OPTIONS = {
  values: [
    '', 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '    User Agent    REG_SZ    Mozilla/4.0 (compatible; MSIE 8.0; Win32)',
    '    EnableNegotiate    REG_DWORD    0x1', '    ProxyEnable    REG_DWORD    0x1', '    MigrateProxy    REG_DWORD    0x1',
    '    ProxyServer    REG_SZ    127.0.0.1:3128', '    ProxyOverride    REG_SZ    <local>;*.corp.test', '    AutoDetect    REG_DWORD    0x0',
    '', 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections', ''
  ].join('\r\n'),
  blob: '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections\r\n    DefaultConnectionSettings    REG_BINARY    4600000021000000030000000E0000003132372E302E302E313A33313238130000003C6C6F63616C3E3B2A2E636F72702E74657374000000000000000000000000000000000000000000000000000000000000000000000000\r\n\r\n'
}

const parse = (values: RegistryFixture, blob?: string, policy?: string): ReturnType<typeof parseWindowsSettings> =>
  parseWindowsSettings({ values: internetSettings(values), blob: blob === undefined ? undefined : connectionBlob(blob), policy })

const MANUAL = { enable: 1, server: '127.0.0.1:3128', override: '<local>;*.corp.test' }

describe('Windows\' proxy settings', () => {
  it('are what a fresh user has: no proxy, and detection on', () => {
    expect(parse({ enable: 0 }, FRESH_BLOB)).toEqual({ kind: 'detect' })
    expect(connectionBlob(FRESH_BLOB)).toContain(`DefaultConnectionSettings    REG_BINARY    ${FRESH_BLOB}\r\n`)
  })

  it('are read from the text as the program printed it, which the helper writes the same way', () => {
    expect(connectionBlob(blobHex(3, '127.0.0.1:3128', '<local>;*.corp.test'))).toBe(SET_BY_INTERNET_OPTIONS.blob)
    expect(parseWindowsSettings({ ...SET_BY_INTERNET_OPTIONS, policy: undefined })).toEqual({ kind: 'manual', proxyRules: '127.0.0.1:3128', exceptions: ['<local>', '*.corp.test'] })
  })

  it('are a manual proxy with the exceptions as written, whichever form carries them', () => {
    const expected = { kind: 'manual', proxyRules: '127.0.0.1:3128', exceptions: ['<local>', '*.corp.test'] }
    expect(parse(MANUAL, blobHex(3, '127.0.0.1:3128', '<local>;*.corp.test'))).toEqual(expected)
    expect(parse(MANUAL)).toEqual(expected)
    expect(parse({}, blobHex(3, '127.0.0.1:3128', '<local>;*.corp.test'))).toEqual(expected)
  })

  it.each([
    [1, { kind: 'none' }], [3, { kind: 'manual', proxyRules: 'p.test:8080', exceptions: [] }], [5, { kind: 'script' }], [9, { kind: 'detect' }], [0x0b, { kind: 'manual', proxyRules: 'p.test:8080', exceptions: [] }]
  ])('read the blob\'s flags %i when no value says otherwise', (flags, expected) => {
    expect(parse({}, blobHex(flags, 'p.test:8080', '', 'http://pac.test/p.pac'))).toEqual(expected)
  })

  it('ignore a proxy or a script of the blob whose flag is off, or whose script has no address', () => {
    expect(parse({}, blobHex(1, 'p.test:8080', '<local>', 'http://pac.test/p.pac'))).toEqual({ kind: 'none' })
    expect(parse({}, blobHex(5, '', '', ''))).toEqual({ kind: 'none' })
  })

  it('are decided by the values as soon as a ProxyEnable value exists, and the blob\'s proxy is ignored', () => {
    expect(parse({ enable: 0, server: 'values.test:3128' }, blobHex(3, 'blob.test:3129', '*.corp.test'))).toEqual({ kind: 'none' })
    expect(parse({ enable: 1 }, blobHex(3, 'blob.test:3129'))).toEqual({ kind: 'none' })
    expect(parse({ enable: 1, server: 'values.test:3128', override: '<local>' }, blobHex(3, 'blob.test:3129', '*.corp.test'))).toEqual({ kind: 'manual', proxyRules: 'values.test:3128', exceptions: ['<local>'] })
    expect(parse({ enable: 1, server: 'values.test:3128' }, blobHex(1))).toMatchObject({ kind: 'manual', proxyRules: 'values.test:3128' })
  })

  it('are decided by the blob when no ProxyEnable value exists, and a ProxyServer value alone is ignored', () => {
    expect(parse({ server: 'values.test:3128', override: '<local>' }, blobHex(3, 'blob.test:3129', '*.corp.test'))).toEqual({ kind: 'manual', proxyRules: 'blob.test:3129', exceptions: ['*.corp.test'] })
    expect(parse({ server: 'values.test:3128' }, blobHex(1))).toEqual({ kind: 'none' })
    expect(parse({ server: 'values.test:3128' })).toEqual({ kind: 'none' })
  })

  it('are a script when a value names one or the blob does, beside a manual proxy too, since the script is what Chromium asks first', () => {
    expect(parse({ enable: 0, scriptUrl: 'http://pac.test/p.pac' }, blobHex(1))).toEqual({ kind: 'script' })
    expect(parse({ enable: 0, scriptUrl: 'http://pac.test/p.pac' })).toEqual({ kind: 'script' })
    expect(parse({ enable: 0 }, blobHex(5, '', '', 'http://pac.test/p.pac'))).toEqual({ kind: 'script' })
    expect(parse(MANUAL, blobHex(7, '127.0.0.1:3128', '<local>', 'http://pac.test/p.pac'))).toEqual({ kind: 'script' })
    expect(parse({ ...MANUAL, scriptUrl: 'http://pac.test/p.pac' })).toEqual({ kind: 'script' })
    expect(parse({ enable: 0, scriptUrl: '' })).toEqual({ kind: 'none' })
  })

  it('are detection when a value or the blob says so, and a manual proxy beside detection is still copied', () => {
    expect(parse({ enable: 0, detect: 1 }, blobHex(1))).toEqual({ kind: 'detect' })
    expect(parse({ enable: 0, detect: 0 }, blobHex(9))).toEqual({ kind: 'detect' })
    expect(parse({ ...MANUAL, detect: 1 }, blobHex(0x0b, '127.0.0.1:3128', '<local>;*.corp.test'))).toEqual({ kind: 'manual', proxyRules: '127.0.0.1:3128', exceptions: ['<local>', '*.corp.test'] })
  })

  it('carry ProxyServer and ProxyOverride as written: a rule for each scheme, a SOCKS server, a list split at the separators Chromium splits at', () => {
    expect(parse({ enable: 1, server: 'http=a.test:1;https=b.test:2;socks=c.test:3', override: '<local>;*.corp.test,10.*  lan.test\t[::1]' })).toEqual({
      kind: 'manual', proxyRules: 'http=a.test:1;https=b.test:2;socks=c.test:3', exceptions: ['<local>', '*.corp.test', '10.*', 'lan.test', '[::1]']
    })
    expect(parse({ enable: 1, server: '  proxy.test:80  ', override: '' })).toEqual({ kind: 'manual', proxyRules: 'proxy.test:80', exceptions: [] })
    expect(parse({ enable: 1, server: 'proxy.test:80' })).toMatchObject({ exceptions: [] })
  })

  it('are no proxy when the proxy is off or names no server', () => {
    expect(parse({ enable: 0, server: 'proxy.test:80' })).toEqual({ kind: 'none' })
    expect(parse({ enable: 1, server: '   ' })).toEqual({ kind: 'none' })
    expect(parse({})).toEqual({ kind: 'none' })
  })

  it('read a blob of no bytes as no blob, and one cut short or of another layout as settings that cannot be carried', () => {
    expect(parse({ enable: 1, server: 'proxy.test:80' }, '')).toEqual({ kind: 'manual', proxyRules: 'proxy.test:80', exceptions: [] })
    expect(parse({}, '')).toEqual({ kind: 'none' })
    const whole = blobHex(3, 'proxy.test:80', '<local>')
    for (const length of [2, 22, 24, 30, 34, whole.length - 2 * 32 - 2]) expect(parse({ enable: 1, server: 'proxy.test:80' }, whole.slice(0, length)), `${String(length)} hex digits`).toEqual({ kind: 'unsupported' })
    for (const version of [0x99, 0x3c]) expect(parse({}, blobHex(3, 'proxy.test:80', '', '', version)), `version ${String(version)}`).toEqual({ kind: 'unsupported' })
    expect(parse({}, 'not hex at all')).toEqual({ kind: 'unsupported' })
    expect(parse({}, '4600000021000000030000000E')).toEqual({ kind: 'unsupported' })
  })

  it('are unsupported under the policy that makes the settings the machine\'s, and read as usual under the same policy turned off', () => {
    expect(parse(MANUAL, blobHex(3, '127.0.0.1:3128'), perUserPolicy(0))).toEqual({ kind: 'unsupported' })
    expect(parse(MANUAL, blobHex(3, '127.0.0.1:3128'), perUserPolicy(1))).toMatchObject({ kind: 'manual' })
    expect(parse(MANUAL, blobHex(3, '127.0.0.1:3128'), undefined)).toMatchObject({ kind: 'manual' })
  })

  it('are unsupported when a value is in a type or holds a character a rule could not carry', () => {
    expect(parse({ extra: ['ProxyEnable    REG_SZ    1'] })).toEqual({ kind: 'unsupported' })
    expect(parseWindowsSettings({ values: internetSettings({ enable: 1 }).replace('MigrateProxy', 'ProxyServer    REG_EXPAND_SZ    %PROXY%\r\n    MigrateProxy'), blob: undefined, policy: undefined })).toEqual({ kind: 'unsupported' })
    expect(parse({ enable: 1, server: 'proxy.test\u0007:80' })).toEqual({ kind: 'unsupported' })
    expect(parse({}, blobHex(3, 'proxy\u0001.test:80'))).toEqual({ kind: 'unsupported' })
  })

  it('are unreadable when the key was not printed', () => {
    expect(parseWindowsSettings({ values: undefined, blob: undefined, policy: undefined })).toEqual({ kind: 'unreadable' })
    expect(parseWindowsSettings({ values: '', blob: undefined, policy: undefined })).toEqual({ kind: 'unreadable' })
    expect(parseWindowsSettings({ values: 'garbage\r\n', blob: undefined, policy: undefined })).toEqual({ kind: 'unreadable' })
    expect(parseWindowsSettings({ values: internetSettings(), blob: 'garbage\r\n', policy: undefined })).toEqual({ kind: 'unreadable' })
  })

  it('match a value\'s name however Windows spells its case', () => {
    expect(parseWindowsSettings({ values: internetSettings().replace('MigrateProxy', 'PROXYENABLE    REG_DWORD    0x1\r\n    proxyserver    REG_SZ    proxy.test:80\r\n    MigrateProxy'), blob: undefined, policy: undefined })).toMatchObject({ kind: 'manual', proxyRules: 'proxy.test:80' })
  })

  it('never carry a value that is not one of the settings, whatever the key holds', () => {
    const registry: WindowsRegistry = { values: internetSettings({ enable: 1, server: 'proxy.test:80', extra: ['Secret    REG_SZ    hunter2-secret'] }), blob: undefined, policy: undefined }
    expect(JSON.stringify(parseWindowsSettings(registry))).not.toContain('hunter2')
  })
})
