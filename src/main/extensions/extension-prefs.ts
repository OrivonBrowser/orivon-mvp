// What a person chose for each installed extension (pinned, granted
// optional permissions and origins, site access, shortcuts, page overrides,
// notices seen) -- pure: parse, normalise and merge, no `electron`, no
// filesystem (extension-prefs-runner.ts is the I/O half). Lenient on read: a
// field that is the wrong shape takes its default instead of failing the
// file, since one bad field must not forget every other extension's choices.

export interface ExtensionPrefs {
  /** null: follow the `extensions.pinNew` setting. */
  readonly pinned: boolean | null
  readonly granted: { readonly permissions: readonly string[], readonly origins: readonly string[] }
  readonly siteAccess: { readonly mode: 'all' | 'sites' | 'click', readonly sites: readonly string[] }
  /** Command name to binding; '' is a binding the person cleared. */
  readonly shortcuts: Readonly<Record<string, string>>
  readonly overrides: { readonly newtab: boolean, readonly history: boolean, readonly bookmarks: boolean }
  readonly noticeSeen: readonly string[]
}

export interface ExtensionPrefsStore {
  get: (id: string) => ExtensionPrefs
  /** Shallow merge of the given top-level fields; an unchanged result writes and notifies nothing. */
  update: (id: string, patch: Partial<ExtensionPrefs>) => void
  forget: (id: string) => void
  /** Called with the id that changed. Returns the removal. */
  onChange: (listener: (id: string) => void) => () => void
}

export const PREFS_FILE_VERSION = 1

const SITE_ACCESS_MODES: readonly string[] = ['all', 'sites', 'click']

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList (value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return Object.freeze([...new Set(value.filter((item): item is string => typeof item === 'string' && item !== ''))])
}

function stringMap (value: unknown): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  if (isRecord(value)) {
    for (const [name, binding] of Object.entries(value)) {
      if (typeof binding === 'string') out[name] = binding
    }
  }
  return Object.freeze(out)
}

function bool (value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** `raw` as preferences: every missing or malformed field takes its default. The result is frozen. */
export function normalizePrefs (raw: unknown): ExtensionPrefs {
  const source = isRecord(raw) ? raw : {}
  const granted = isRecord(source['granted']) ? source['granted'] : {}
  const siteAccess = isRecord(source['siteAccess']) ? source['siteAccess'] : {}
  const overrides = isRecord(source['overrides']) ? source['overrides'] : {}
  const mode = typeof siteAccess['mode'] === 'string' && SITE_ACCESS_MODES.includes(siteAccess['mode'])
    ? siteAccess['mode'] as 'all' | 'sites' | 'click'
    : 'all'
  return Object.freeze({
    pinned: typeof source['pinned'] === 'boolean' ? source['pinned'] : null,
    granted: Object.freeze({ permissions: stringList(granted['permissions']), origins: stringList(granted['origins']) }),
    siteAccess: Object.freeze({ mode, sites: stringList(siteAccess['sites']) }),
    shortcuts: stringMap(source['shortcuts']),
    overrides: Object.freeze({
      newtab: bool(overrides['newtab'], true),
      history: bool(overrides['history'], true),
      bookmarks: bool(overrides['bookmarks'], true)
    }),
    noticeSeen: stringList(source['noticeSeen'])
  })
}

export const DEFAULT_EXTENSION_PREFS: ExtensionPrefs = normalizePrefs({})

/** `current` with the top-level fields of `patch` replaced, normalised again so a bad patch field cannot poison the record. */
export function mergePrefs (current: ExtensionPrefs, patch: Partial<ExtensionPrefs>): ExtensionPrefs {
  const merged: Record<string, unknown> = { ...current }
  for (const [name, value] of Object.entries(patch)) {
    if (value !== undefined && Object.hasOwn(DEFAULT_EXTENSION_PREFS, name)) merged[name] = value
  }
  return normalizePrefs(merged)
}

export function prefsEqual (a: ExtensionPrefs, b: ExtensionPrefs): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The extensions with a stored record. An id whose record is not an object is dropped; the file as a whole is never refused. */
export function parsePrefsFile (text: string): Map<string, ExtensionPrefs> {
  const out = new Map<string, ExtensionPrefs>()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return out
  }
  if (!isRecord(parsed) || parsed['version'] !== PREFS_FILE_VERSION || !isRecord(parsed['extensions'])) return out
  for (const [id, record] of Object.entries(parsed['extensions'])) {
    if (id !== '' && isRecord(record)) out.set(id, normalizePrefs(record))
  }
  return out
}

/** Only an extension whose record differs from the defaults is written, so the file stays as small as the choices made. */
export function serializePrefs (records: ReadonlyMap<string, ExtensionPrefs>): string {
  const extensions: Record<string, ExtensionPrefs> = {}
  for (const [id, prefs] of records) {
    if (!prefsEqual(prefs, DEFAULT_EXTENSION_PREFS)) extensions[id] = prefs
  }
  return JSON.stringify({ version: PREFS_FILE_VERSION, extensions }, null, 2)
}
