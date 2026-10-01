// Pure decisions over a Chrome extension's parsed manifest.json -- no
// electron, no Node I/O (this directory's own README): read the facts,
// decide what Orivon actually loads, and describe the install prompt in
// words.
//
// The `orivon` manifest key is refused, not parsed: Orivon does not grant
// extensions its own permissions yet.

import { isArray, isString, ownProperty } from './own-property.js'
import { PERMISSION_WORDS, friendlyHost, isAllSitesPattern } from './extension-permission-words.js'

export interface ExtensionManifestFacts {
  readonly manifestVersion: 2 | 3
  readonly name: string
  readonly version: string
  readonly description?: string
  /** Sorted, unique: host_permissions, MV2's host-pattern entries inside
   * `permissions`, and every content_scripts[].matches entry. Display only
   * -- see `hostPermissions` for what an API access decision must use
   * instead, and why. */
  readonly hostPatterns: readonly string[]
  /** Sorted, unique: host_permissions and MV2's host-pattern entries inside
   * `permissions`, never content_scripts[].matches. Chrome tracks these as
   * two separate sets (explicit_hosts vs. scriptable_hosts) and keeps API
   * access on explicit_hosts alone -- a content script's match pattern only
   * lets it inject there, per Chromium's own extensions/docs/permissions.md
   * ("we treat both explicit hosts and scriptable hosts the same [for
   * messaging]... the distinction is only to... restrict what we provide
   * the extension" for the API surface). `optional_host_permissions` is
   * excluded too: it is not granted until the extension requests it at
   * runtime, a separate prompt this field does not anticipate. */
  readonly hostPermissions: readonly string[]
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

/** `sandbox.pages` beyond this many entries is refused outright, never
 * silently truncated: `isSandboxPageUrl` (vendor/electron-chrome-
 * extensions/src/browser/router.ts, UPSTREAM.md patch 39) runs
 * synchronously on the main thread for every page load and `crx-msg`, so an
 * unbounded list is a real DoS surface; but truncating which declared pages
 * it recognises -- as an earlier version of that matcher did -- would leave
 * a page past the cut still declared sandboxed by the manifest, still
 * served by Electron, and refused no CSP and no chrome.* refusal at all: a
 * silent sandbox bypass. Refusing the whole manifest here means the matcher
 * itself never needs a cap: every extension it ever sees already fits. */
const MAX_SANDBOX_PAGES = 200

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

/** Chrome's own manifest `version` grammar (developer.chrome.com/docs/
 * extensions/reference/manifest/version): one to four dot-separated
 * integers, each 0-65535, no leading zeros except a bare "0". Refused
 * rather than repaired (this file's own stance on untrusted input) --
 * install-runner.ts's finishInstall joins this string straight into the
 * path it writes the loaded copy to (its own doc, and
 * src/main/extensions/README.md's Design notes), so a value shaped like a
 * path (`../../../../x`) must never pass this grammar as a plausible
 * version. */
function isValidExtensionVersion (version: string): boolean {
  const parts = version.split('.')
  if (parts.length < 1 || parts.length > 4) return false
  return parts.every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 65535)
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
  if (!isValidExtensionVersion(version)) {
    return {
      ok: false,
      reason: `version must be 1-4 dot-separated integers, each 0-65535, no leading zeros: got ${JSON.stringify(version)}`
    }
  }

  const permissions = stringArray(ownProperty(raw, 'permissions', isArray))
  const optionalPermissions = stringArray(ownProperty(raw, 'optional_permissions', isArray))
  const hostPermissions = stringArray(ownProperty(raw, 'host_permissions', isArray))
  const contentScripts = readContentScripts(ownProperty(raw, 'content_scripts', isArray))

  const explicitHostPermissions = sortedUnique([
    ...hostPermissions,
    ...permissions.filter(isHostPatternLike)
  ])
  const hostPatterns = sortedUnique([
    ...explicitHostPermissions,
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

  const sandboxSection = ownProperty(raw, 'sandbox', (v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v))
  const sandboxPages = sandboxSection === undefined ? [] : stringArray(ownProperty(sandboxSection, 'pages', isArray))
  if (sandboxPages.length > MAX_SANDBOX_PAGES) {
    return { ok: false, reason: `sandbox.pages has ${String(sandboxPages.length)} entries, more than the ${String(MAX_SANDBOX_PAGES)} this build matches` }
  }

  const facts: ExtensionManifestFacts = {
    manifestVersion: manifestVersionRaw,
    name,
    version,
    ...(description === undefined ? {} : { description }),
    hostPatterns,
    hostPermissions: explicitHostPermissions,
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

/**
 * `stripped` in plain words, for the extensions page's details view -- one
 * line per capability `loadableManifest` removed, never the raw permission
 * name. Order matches the order `isStrippedPermission` would find them in an
 * unstripped manifest: network rules before native messaging.
 */
export function describeStrippedPermissions (stripped: StrippedRecord): readonly string[] {
  const names = [...stripped.permissions, ...stripped.optionalPermissions]
  const lines: string[] = []
  if (names.some((name) => name.startsWith('webRequest') || name.startsWith('declarativeNetRequest')) || stripped.declarativeNetRequest !== undefined) {
    lines.push('Network blocking rules: Orivon does not run these yet')
  }
  if (names.includes('nativeMessaging')) {
    lines.push('Talking to programs on your computer: not available in Orivon')
  }
  return lines
}

// --- the install prompt's words ---

export type ExtensionInstallSource = 'unpacked' | 'file' | 'store'

export interface ExtensionInstallDescription {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly warning: boolean
}

const MAX_LISTED_HOSTS = 5

/**
 * Where an extension runs beyond ordinary websites, and what it may not do
 * there: shared by the install prompt's Web3 line and the extensions page's
 * "where it runs" line so the two never drift apart.
 */
export const GRANTED_APPS_CLAUSE = 'apps you have given permissions to, except an app running from its pinned copy'
export const GRANTS_STAY_WITH_APPS = 'Orivon keeps its code from using the permissions you have given those apps.'

/**
 * The host-access line(s) Chrome's own install prompt would show for
 * `facts`, with no trailing API-permission lines -- split out of
 * `describeExtensionInstall` so the extensions page's "Site access" field
 * can show the identical words without re-deriving them.
 */
export function describeHostAccess (facts: ExtensionManifestFacts): string | undefined {
  if (facts.hostPatterns.length === 0) return undefined
  if (facts.hostPatterns.some(isAllSitesPattern)) return 'Read and change all your data on all websites'
  const hosts = facts.hostPatterns.map(friendlyHost)
  const shown = hosts.slice(0, MAX_LISTED_HOSTS)
  const rest = hosts.length - shown.length
  return `Read and change your data on these sites: ${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`
}

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

/** Permissions API_PERMISSION_LINES already words: PERMISSION_WORDS adds a
 * line only for the others, so no permission is listed twice. */
const NAMED_ABOVE = new Set(API_PERMISSION_LINES.flatMap(({ names }) => names))

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

  const hostAccess = describeHostAccess(facts)
  if (hostAccess !== undefined) lines.push(hostAccess)
  if (hasHostAccess) {
    lines.push(`It also runs on Web3 sites and on ${GRANTED_APPS_CLAUSE}. ${GRANTS_STAY_WITH_APPS}`)
  }

  for (const { names, line } of API_PERMISSION_LINES) {
    if (names.some((name) => facts.apiPermissions.includes(name))) lines.push(line)
  }
  for (const [name, line] of Object.entries(PERMISSION_WORDS)) {
    if (!NAMED_ABOVE.has(name) && facts.apiPermissions.includes(name)) lines.push(line)
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

const WARNING_API_PERMISSIONS = new Set([...NAMED_ABOVE, ...Object.keys(PERMISSION_WORDS)])

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
