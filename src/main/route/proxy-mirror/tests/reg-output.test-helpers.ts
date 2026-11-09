// What `reg query` printed on a Windows computer, as the program prints it: CRLF line ends, four spaces between a value's name, type and
// data, the key's own values first and then the names of its subkeys. The base lines are those of a GitHub Windows runner with a
// fresh user: detection on (in the blob only) and no proxy.

const KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

const SUBKEYS = ['5.0', 'Cache', 'Connections', 'Http Filters', 'Lockdown_Zones', 'P3P', 'Passport', 'Wpad', 'ZoneMap', 'Zones']

const BASE_VALUES = [
  'CertificateRevocation    REG_DWORD    0x1',
  'DisableCachingOfSSLPages    REG_DWORD    0x0',
  'IE5_UA_Backup_Flag    REG_SZ    5.0',
  'PrivacyAdvanced    REG_DWORD    0x1',
  'SecureProtocols    REG_DWORD    0x2800',
  'User Agent    REG_SZ    Mozilla/4.0 (compatible; MSIE 8.0; Win32)',
  'ZonesSecurityUpgrade    REG_BINARY    24F8196DC06BDD01',
  'WarnonZoneCrossing    REG_DWORD    0x0',
  'EnableNegotiate    REG_DWORD    0x1'
]

const crlf = (lines: readonly string[]): string => `\r\n${lines.join('\r\n')}\r\n`

export interface RegistryFixture {
  /** `ProxyEnable`; left out of the key when undefined. */
  readonly enable?: number
  readonly server?: string
  readonly override?: string
  /** `AutoConfigURL`. */
  readonly scriptUrl?: string
  /** `AutoDetect`. */
  readonly detect?: number
  /** Extra lines of values, as printed after the others. */
  readonly extra?: readonly string[]
}

/** `reg query` of the Internet Settings key. */
export function internetSettings (fixture: RegistryFixture = {}): string {
  const values = [...BASE_VALUES]
  if (fixture.enable !== undefined) values.push(`ProxyEnable    REG_DWORD    0x${fixture.enable.toString(16)}`)
  values.push('MigrateProxy    REG_DWORD    0x1')
  if (fixture.server !== undefined) values.push(`ProxyServer    REG_SZ    ${fixture.server}`)
  if (fixture.override !== undefined) values.push(`ProxyOverride    REG_SZ    ${fixture.override}`)
  if (fixture.scriptUrl !== undefined) values.push(`AutoConfigURL    REG_SZ    ${fixture.scriptUrl}`)
  if (fixture.detect !== undefined) values.push(`AutoDetect    REG_DWORD    0x${fixture.detect.toString(16)}`)
  values.push(...(fixture.extra ?? []))
  return crlf([KEY, ...values.map((line) => `    ${line}`), '', ...SUBKEYS.map((name) => `${KEY}\\${name}`)])
}

const dword = (value: number): number[] => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]
const string = (value: string): number[] => [...dword(value.length), ...Buffer.from(value, 'latin1')]

/** The blob as WinINET writes it: version, change counter, flags, three length-prefixed strings, 32 reserved bytes. Hex, as `reg query` prints it. */
export function blobHex (flags: number, proxy = '', bypass = '', script = '', version = 0x46): string {
  const bytes = [...dword(version), ...dword(0x21), ...dword(flags), ...string(proxy), ...string(bypass), ...string(script), ...new Array<number>(32).fill(0)]
  return Buffer.from(bytes).toString('hex').toUpperCase()
}

/** `reg query` of the Connections key for its `DefaultConnectionSettings` value, whose data is `hex`. */
export function connectionBlob (hex: string): string {
  return crlf([`${KEY}\\Connections`, `    DefaultConnectionSettings    REG_BINARY    ${hex}`, ''])
}

/** `reg query` of the machine policy value. */
export function perUserPolicy (value: number): string {
  return crlf(['HKEY_LOCAL_MACHINE\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', `    ProxySettingsPerUser    REG_DWORD    0x${value.toString(16)}`, ''])
}
