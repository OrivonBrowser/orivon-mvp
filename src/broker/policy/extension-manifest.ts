// Pure decisions over a Chrome extension's parsed manifest.json -- no
// electron, no Node I/O (this directory's own README): read the facts,
// decide what Orivon actually loads, and describe the install prompt in
// words.
//
// The `orivon` manifest key is refused, not parsed: Orivon does not grant
// extensions its own permissions yet.

import { isArray, isString, ownProperty } from './own-property.js'

export interface ExtensionManifestFacts {
  readonly manifestVersion: 2 | 3
  readonly name: string
  readonly version: string
  readonly description?: string
  /** Sorted, unique: host_permissions, MV2's host-pattern entries inside
   * `permissions`, and every content_scripts[].matches entry. */
  readonly hostPatterns: readonly string[]
  /** `permissions`, with host-pattern-shaped entries (MV2) filtered out. */
  readonly apiPermissions: readonly string[]
  /** `optional_permissions`, same filter. */
  readonly optionalApiPermissions: readonly string[]
  /** `js` paths from content_scripts entries declaring `"world": "MAIN"`. */
  readonly mainWorldScripts: readonly string[]
  readonly webAccessible: boolean
  readonly usesScripting: boolean
  readonly hasKey: boolean
  readonly updateUrl?: string
  /** Whether a top-level `orivon` key is present. Always false on a value
   * this file actually returns as facts -- see readExtensionManifest's own
   * doc for why the field still exists. */
  readonly orivonKey: boolean
}

export type ExtensionManifestResult =
  | { readonly ok: true, readonly facts: ExtensionManifestFacts }
  | { readonly ok: false, readonly reason: string }

const ORIVON_KEY_REFUSAL = 'Orivon permissions are not supported yet'

/** A match-pattern-shaped string (`<all_urls>` or `scheme://...`), never an
 * API permission name -- API permission names never contain `://` and Chrome
 * never names one `<all_urls>`, so this is an exact, not a heuristic, split
 * for MV2's habit of listing both kinds in one `permissions` array. */
function isHostPatternLike (entry: string): boolean {
  return entry === '<all_urls>' || /^[a-zA-Z*][a-zA-Z0-9+.-]*:\/\//.test(entry)
}

function sortedUnique (entries: readonly string[]): readonly string[] {
  return [...new Set(entries)].sort()
}

function stringArray (value: unknown): readonly string[] {
  return isArray(value) ? value.filter(isString) : []
}

interface ContentScriptEntry {
  readonly matches: readonly string[]
  readonly js: readonly string[]
  readonly world: string | undefined
}

function readContentScripts (raw: unknown): readonly ContentScriptEntry[] {
  if (!isArray(raw)) return []
  const entries: ContentScriptEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const matches = stringArray(ownProperty(item, 'matches', isArray))
    const js = stringArray(ownProperty(item, 'js', isArray))
    const world = ownProperty(item, 'world', isString)
    entries.push({ matches, js, world })
  }
  return entries
}

/**
 * Reads and validates a parsed `manifest.json` value. Refuses rather than
 * repairs (loader/manifest/manifest.ts's own stance on untrusted input):
 * not an object, a `manifest_version` other than 2 or 3, or a missing/
 * non-string `name`/`version`. `__MSG_...` names pass through unchanged --
 * they are message-catalogue references the extension's own page resolves,
 * not something this file can or should look up.
 */
export function readExtensionManifest (raw: unknown): ExtensionManifestResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'manifest is not an object' }
  }

  const manifestVersionRaw = ownProperty(raw, 'manifest_version', (v): v is number => typeof v === 'number')
  if (manifestVersionRaw !== 2 && manifestVersionRaw !== 3) {
    return { ok: false, reason: `manifest_version must be 2 or 3, got ${JSON.stringify(manifestVersionRaw)}` }
  }

  const name = ownProperty(raw, 'name', isString)
  if (name === undefined) return { ok: false, reason: 'missing or non-string name' }
  const version = ownProperty(raw, 'version', isString)
  if (version === undefined) return { ok: false, reason: 'missing or non-string version' }

  const permissions = stringArray(ownProperty(raw, 'permissions', isArray))
  const optionalPermissions = stringArray(ownProperty(raw, 'optional_permissions', isArray))
  const hostPermissions = stringArray(ownProperty(raw, 'host_permissions', isArray))
  const contentScripts = readContentScripts(ownProperty(raw, 'content_scripts', isArray))

  const hostPatterns = sortedUnique([
    ...hostPermissions,
    ...permissions.filter(isHostPatternLike),
    ...contentScripts.flatMap((entry) => entry.matches)
  ])
  const apiPermissions = sortedUnique(permissions.filter((entry) => !isHostPatternLike(entry)))
  const optionalApiPermissions = sortedUnique(optionalPermissions.filter((entry) => !isHostPatternLike(entry)))
  const mainWorldScripts = sortedUnique(
    contentScripts.filter((entry) => entry.world === 'MAIN').flatMap((entry) => entry.js)
  )

  const description = ownProperty(raw, 'description', isString)
  const updateUrl = ownProperty(raw, 'update_url', isString)
  const webAccessible = Object.hasOwn(raw, 'web_accessible_resources')
  const hasKey = ownProperty(raw, 'key', isString) !== undefined
  const orivonKey = Object.hasOwn(raw, 'orivon')

  if (orivonKey) return { ok: false, reason: ORIVON_KEY_REFUSAL }

  const facts: ExtensionManifestFacts = {
    manifestVersion: manifestVersionRaw,
    name,
    version,
    ...(description === undefined ? {} : { description }),
    hostPatterns,
    apiPermissions,
    optionalApiPermissions,
    mainWorldScripts,
    webAccessible,
    usesScripting: apiPermissions.includes('scripting') || optionalApiPermissions.includes('scripting'),
    hasKey,
    ...(updateUrl === undefined ? {} : { updateUrl }),
    orivonKey: false
  }
  return { ok: true, facts }
}

// --- the loaded copy: strip what would crash the session (README's Design notes) ---

/** Permission names removed from BOTH `permissions` and `optional_permissions`
 * of the copy Orivon actually loads. */
function isStrippedPermission (name: string): boolean {
  return name === 'nativeMessaging' || name.startsWith('webRequest') || name.startsWith('declarativeNetRequest')
}

export interface StrippedRecord {
  readonly permissions: readonly string[]
  readonly optionalPermissions: readonly string[]
  readonly declarativeNetRequest: unknown
}

export interface LoadableManifestResult {
  readonly manifest: Record<string, unknown>
  readonly stripped: StrippedRecord
}

/**
 * The manifest copy Orivon writes into the folder it loads: every
 * `webRequest*`/`declarativeNetRequest*` permission and `nativeMessaging`
 * removed from `permissions`/`optional_permissions`, and the top-level
 * `declarative_net_request` key moved out entirely. `stripped` records
 * exactly what was removed, so those APIs could be served from Orivon's own
 * engine later -- see this directory's README, Design notes, for why either
 * permission left in place crashes the main process on the session's first
 * `net.fetch`.
 */
export function loadableManifest (raw: Record<string, unknown>): LoadableManifestResult {
  const permissions = stringArray(raw.permissions)
  const optionalPermissions = stringArray(raw.optional_permissions)
  const removedPermissions = permissions.filter(isStrippedPermission)
  const removedOptional = optionalPermissions.filter(isStrippedPermission)

  const manifest: Record<string, unknown> = { ...raw }
  if (Object.hasOwn(manifest, 'permissions')) {
    manifest.permissions = permissions.filter((name) => !isStrippedPermission(name))
  }
  if (Object.hasOwn(manifest, 'optional_permissions')) {
    manifest.optional_permissions = optionalPermissions.filter((name) => !isStrippedPermission(name))
  }
  const declarativeNetRequest = manifest.declarative_net_request
  delete manifest.declarative_net_request

  return {
    manifest,
    stripped: {
      permissions: removedPermissions,
      optionalPermissions: removedOptional,
      declarativeNetRequest
    }
  }
}

// --- the install prompt's words ---

export type ExtensionInstallSource = 'unpacked' | 'file' | 'store'

export interface ExtensionInstallDescription {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly warning: boolean
}

const ALL_SITES_PATTERNS = new Set(['<all_urls>', '*://*/*'])

/** True for a pattern that, on its own, already covers every site: the two
 * members of ALL_SITES_PATTERNS above. A scheme-qualified equivalent
 * (matching http alone, say) is deliberately NOT treated as all-sites here,
 * since it still excludes https. (A literal "star colon slash slash star
 * slash star" is not spelled out in this comment -- it closes a block
 * comment early.) */
function isAllSitesPattern (pattern: string): boolean {
  return ALL_SITES_PATTERNS.has(pattern)
}

/** A pattern's host portion for display: everything between "://" and the
 * next "/". Falls back to the raw pattern when it does not parse in that
 * scheme-host-path shape -- display only, never used for a security
 * decision. */
function friendlyHost (pattern: string): string {
  const match = /^[a-zA-Z*][a-zA-Z0-9+.-]*:\/\/([^/]+)/.exec(pattern)
  return match?.[1] ?? pattern
}

const MAX_LISTED_HOSTS = 5

/** Chrome's own permission-warning text, cited at
 * https://developer.chrome.com/docs/extensions/reference/permissions-list.
 * `cookies` and `proxy` have no dedicated warning in Chrome's own list
 * (chrome/common/extensions/permissions/chrome_api_permissions.cc defines
 * neither with a permission-message flag) -- Orivon still names them here,
 * since a person deciding whether to install should see them; the wording
 * for those two is Orivon's own, not transcribed from Chrome. */
const API_PERMISSION_LINES: ReadonlyArray<{ names: readonly string[], line: string }> = [
  { names: ['tabs', 'webNavigation'], line: 'Read your browsing history' },
  { names: ['cookies'], line: 'Read and change your cookies' },
  { names: ['clipboardRead'], line: 'Read data you copy and paste' },
  { names: ['clipboardWrite'], line: 'Modify data you copy and paste' },
  { names: ['downloads'], line: 'Manage your downloads' },
  { names: ['notifications'], line: 'Display notifications' },
  { names: ['management'], line: 'Manage your apps, extensions, and themes' },
  { names: ['privacy'], line: 'Change your privacy-related settings' },
  { names: ['proxy'], line: 'Change your proxy settings' },
  { names: ['debugger'], line: 'Access the page debugger backend' }
]

const TITLE_BY_SOURCE: Record<ExtensionInstallSource, (name: string) => string> = {
  unpacked: (name) => `Load "${name}"?`,
  file: (name) => `Install "${name}"?`,
  store: (name) => `Add "${name}" to Orivon?`
}

/**
 * The install prompt's words for `facts`, from `source`. Host access is
 * described in Chrome's own wording; the Web3 line always follows it,
 * because an extension with any host access also runs on Web3 sites, which
 * share the default session with it -- but not on an app the person has
 * given permissions to, since that app runs in its own session partition,
 * where no extension loads.
 */
export function describeExtensionInstall (facts: ExtensionManifestFacts, source: ExtensionInstallSource): ExtensionInstallDescription {
  const lines: string[] = []
  const hasHostAccess = facts.hostPatterns.length > 0
  const allSites = facts.hostPatterns.some(isAllSitesPattern)

  if (allSites) {
    lines.push('Read and change all your data on all websites')
  } else if (hasHostAccess) {
    const hosts = facts.hostPatterns.map(friendlyHost)
    const shown = hosts.slice(0, MAX_LISTED_HOSTS)
    const rest = hosts.length - shown.length
    lines.push(`Read and change your data on these sites: ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`)
  }
  if (hasHostAccess) {
    lines.push('It also runs on Web3 sites, but not on apps you have given permissions to.')
  }

  for (const { names, line } of API_PERMISSION_LINES) {
    if (names.some((name) => facts.apiPermissions.includes(name))) lines.push(line)
  }

  const detail = lines.join('\n')
  return {
    title: TITLE_BY_SOURCE[source](facts.name),
    message: facts.description ?? facts.name,
    detail,
    warning: allSites
  }
}

// --- re-consent on update (T19's subset rule, applied to extensions) ---

/** Order-independent: every pattern in `subset` must appear, verbatim, in
 * `superset`. Exact membership, not the runtime `*`-matching grammar
 * `src/broker/policy/connect-patterns.ts` uses for capability patterns --
 * an extension's host patterns are Chrome match patterns, a different
 * grammar, and exact membership is enough to decide "did this widen" here.
 * A pattern rewritten to an equivalent but differently-spelled form (an
 * all-sites pattern vs two scheme-qualified patterns covering the same
 * hosts) re-prompts under this rule; narrowing that gap needs the same
 * grammar connect-patterns.ts already has, and is not done here. */
function isSubsetOf (subset: readonly string[], superset: readonly string[]): boolean {
  const supersetSet = new Set(superset)
  return subset.every((pattern) => supersetSet.has(pattern))
}

const WARNING_API_PERMISSIONS = new Set(
  API_PERMISSION_LINES.flatMap(({ names }) => names)
)

/**
 * True when an update from `previous` to `next` must re-prompt before the
 * new version runs: `next.hostPatterns` reaches somewhere `previous` did
 * not, or `next` adds a required API permission that carries an install
 * warning line above. Optional permissions are excluded on purpose -- an
 * extension does not hold one until it actually requests it at runtime,
 * which is its own prompt, not an update-time one.
 */
export function updateRequiresConsent (previous: ExtensionManifestFacts, next: ExtensionManifestFacts): boolean {
  if (!isSubsetOf(next.hostPatterns, previous.hostPatterns)) return true
  const addedWarningPermission = next.apiPermissions.some(
    (name) => WARNING_API_PERMISSIONS.has(name) && !previous.apiPermissions.includes(name)
  )
  return addedWarningPermission
}
