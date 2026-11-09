// Windows' proxy settings (the per-user Internet Settings in the registry) as `reg query` prints them, turned into what the
// mirror copies. It reads the two forms Windows keeps, the values (`ProxyEnable` and kin) and the `DefaultConnectionSettings`
// blob, by the rule Chromium's reader follows, measured (README.md's Design notes). `ProxyServer` and `ProxyOverride` pass as
// written, since Chromium reads the same text with the same parser. Only the values it needs are read. Pure.

import type { SystemSettings } from './settings-source.js'

/** What the three `reg query` calls printed, each undefined when the key or value is not there. */
export interface WindowsRegistry {
  /** The Internet Settings key, every value of it. */
  readonly values: string | undefined
  /** The `DefaultConnectionSettings` value of its `Connections` key. */
  readonly blob: string | undefined
  /** The machine policy `ProxySettingsPerUser`. */
  readonly policy: string | undefined
}

interface Entry {
  readonly type: string
  readonly data: string
}

interface Blob {
  readonly flags: number
  readonly proxy: string
  readonly bypass: string
  readonly script: string
}

/** A setting that is there but not in a form this reader can carry exactly. */
class NotCarried extends Error {}

const PROXY = 2
const SCRIPT = 4
const DETECT = 8
/** The blob's first word, as every Windows since Internet Explorer 6 writes it; a blob of another layout is not read. */
const BLOB_VERSION = 0x46
const VALUE_LINE = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/
const KEY_LINE = /^HKEY_[A-Z_]+\\.+$/
/** A character no registry text of a proxy holds; one in a rule could end it or start another. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
/** The separators Chromium's Windows reader splits the override list at. */
const OVERRIDE_SEPARATORS = /[;, \t\n\r]+/

/** The values `reg query` printed under their key, by lower-case name; undefined when it printed no key at all. */
function entriesOf (output: string | undefined): Map<string, Entry> | undefined {
  if (output === undefined) return undefined
  const entries = new Map<string, Entry>()
  let keyed = false
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (KEY_LINE.test(line)) {
      keyed = true
      continue
    }
    const found = VALUE_LINE.exec(line)
    if (found !== null && keyed) entries.set((found[1] as string).toLowerCase(), { type: found[2] as string, data: found[3] ?? '' })
  }
  return keyed ? entries : undefined
}

function dword (entry: Entry | undefined): number | undefined {
  if (entry === undefined) return undefined
  if (entry.type !== 'REG_DWORD' || !/^0x[0-9a-f]{1,8}$/i.test(entry.data)) throw new NotCarried()
  return Number(entry.data)
}

function text (entry: Entry | undefined): string {
  if (entry === undefined) return ''
  if (entry.type !== 'REG_SZ' || CONTROL.test(entry.data)) throw new NotCarried()
  return entry.data.trim()
}

/** The blob's fields, `'empty'` for a value of no bytes (a tool that cleared it), or undefined for one that is cut short or of a layout this reader does not know. */
function blobOf (entry: Entry): Blob | 'empty' | undefined {
  if (entry.type !== 'REG_BINARY' || !/^(?:[0-9a-f]{2})*$/i.test(entry.data)) return undefined
  const bytes = Buffer.from(entry.data, 'hex')
  if (bytes.length === 0) return 'empty'
  if (bytes.length < 12 || bytes.readUInt32LE(0) !== BLOB_VERSION) return undefined
  const strings: string[] = []
  let at = 12
  for (let index = 0; index < 3; index += 1) {
    if (at + 4 > bytes.length) return undefined
    const length = bytes.readUInt32LE(at)
    at += 4
    if (length > bytes.length - at) return undefined
    strings.push(bytes.subarray(at, at + length).toString('latin1'))
    at += length
  }
  const [proxy, bypass, script] = strings as [string, string, string]
  if ([proxy, bypass, script].some((one) => CONTROL.test(one))) return undefined
  return { flags: bytes.readUInt32LE(8), proxy: proxy.trim(), bypass, script: script.trim() }
}

/** The manual proxy of the form Chromium reads: the values when a `ProxyEnable` value says something (on, or off beside a `ProxyServer`), else the blob. */
function manualOf (values: Map<string, Entry>, blob: Blob | undefined): { readonly server: string, readonly bypass: string } | undefined {
  const enable = dword(values.get('proxyenable'))
  if (enable !== undefined) {
    const server = text(values.get('proxyserver'))
    if (enable !== 0) return { server, bypass: text(values.get('proxyoverride')) }
    if (server !== '') return undefined
  }
  return blob !== undefined && (blob.flags & PROXY) !== 0 ? { server: blob.proxy, bypass: blob.bypass } : undefined
}

/** What the three `reg query` calls printed, as the settings Chromium's Windows reader would make of them. */
export function parseWindowsSettings (registry: WindowsRegistry): SystemSettings {
  try {
    const policy = entriesOf(registry.policy)?.get('proxysettingsperuser')
    if (policy !== undefined && dword(policy) === 0) return { kind: 'unsupported' }
    const values = entriesOf(registry.values)
    const connections = entriesOf(registry.blob)
    if (values === undefined || (registry.blob !== undefined && connections === undefined)) return { kind: 'unreadable' }
    const stored = connections?.get('defaultconnectionsettings')
    const parsed = stored === undefined ? undefined : blobOf(stored)
    if (stored !== undefined && parsed === undefined) return { kind: 'unsupported' }
    const blob = parsed === 'empty' ? undefined : parsed
    // A script wins over a manual proxy in both forms, and detection beside a manual proxy is left to the canary check.
    if (text(values.get('autoconfigurl')) !== '' || (blob !== undefined && (blob.flags & SCRIPT) !== 0 && blob.script !== '')) return { kind: 'script' }
    const manual = manualOf(values, blob)
    if (manual !== undefined && manual.server !== '') {
      return { kind: 'manual', proxyRules: manual.server, exceptions: manual.bypass.split(OVERRIDE_SEPARATORS).filter((entry) => entry !== '') }
    }
    const detect = (dword(values.get('autodetect')) ?? 0) !== 0 || (blob !== undefined && (blob.flags & DETECT) !== 0)
    return { kind: detect ? 'detect' : 'none' }
  } catch (error) {
    if (error instanceof NotCarried) return { kind: 'unsupported' }
    throw error
  }
}
