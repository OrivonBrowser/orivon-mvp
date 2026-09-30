// Every setting, in one place: its default, and what a value must be to be
// accepted. The store validates against this and the Settings page is told
// this, so the page cannot offer a value the store would refuse and a file
// edited by hand cannot make one up.
import { isAddressList, isEmptyOrAddress, MAX_LISTED_ADDRESSES } from './address-checks.js'
import { isEmptyOrAbsolutePath } from './path-checks.js'
import { CUSTOM_SEARCH_ENGINE, DEFAULT_SEARCH_ENGINE, SEARCH_ENGINES, isValidSearchTemplate } from '../browsing/search-engines.js'

export type SettingSpec =
  /** `labels` names options that are data, such as a search engine's own name; wording about an option is the page's. */
  | { readonly kind: 'enum', readonly options: readonly string[], readonly default: string, readonly labels?: Readonly<Record<string, string>> }
  | { readonly kind: 'bool', readonly default: boolean }
  | { readonly kind: 'int', readonly default: number, readonly min: number, readonly max: number }
  | { readonly kind: 'text', readonly default: string, readonly maxLength: number, readonly check?: (value: string) => boolean }

const SPECS = {
  'appearance.theme': { kind: 'enum', options: ['system', 'light', 'dark'], default: 'system' },
  // 'auto' shows the bar when there is a bookmark to put in it.
  'appearance.bookmarksBar': { kind: 'enum', options: ['auto', 'always', 'never'], default: 'auto' },
  // Percent, as text: a choice among the zoom levels, and the level a site with none of its own gets.
  'appearance.defaultZoom': {
    kind: 'enum',
    options: ['75', '80', '90', '100', '110', '125', '150', '175', '200'],
    default: '100',
    labels: { 75: '75%', 80: '80%', 90: '90%', 100: '100%', 110: '110%', 125: '125%', 150: '150%', 175: '175%', 200: '200%' }
  },
  'search.engine': {
    kind: 'enum',
    options: [...SEARCH_ENGINES.map((engine) => engine.id), CUSTOM_SEARCH_ENGINE],
    default: DEFAULT_SEARCH_ENGINE,
    labels: { ...Object.fromEntries(SEARCH_ENGINES.map((engine) => [engine.id, engine.label])), [CUSTOM_SEARCH_ENGINE]: 'Custom' }
  },
  'search.customUrl': { kind: 'text', default: '', maxLength: 2048, check: (value) => value === '' || isValidSearchTemplate(value) },
  // Whether the address bar finishes what is typed from pages already visited, and whether it keeps the whole address visible.
  'addressBar.autocomplete': { kind: 'bool', default: true },
  'addressBar.showFullUrl': { kind: 'bool', default: false },
  // Whether what is typed is also sent to the search engine for suggestions: off, since it tells the engine what is being typed.
  'search.suggestions': { kind: 'bool', default: false },
  // Where downloads go: empty is the operating system's Downloads folder. With askWhere off a file is saved there without a dialog.
  'downloads.folder': { kind: 'text', default: '', maxLength: 4096, check: isEmptyOrAbsolutePath },
  'downloads.askWhere': { kind: 'bool', default: false },
  // Whether starting a download opens the list under the toolbar button.
  'downloads.showBubble': { kind: 'bool', default: true },
  // Whether pages are written down, and for how long. 90 days is provisional: what a person expects a browser to remember is not yet measured.
  'history.remember': { kind: 'bool', default: true },
  'history.retentionDays': { kind: 'enum', options: ['7', '30', '90', 'forever'], default: '90', labels: { 7: '7 days', 30: '30 days', 90: '90 days', forever: 'Forever' } },
  // Network privacy: what Orivon tells sites and how it connects. All off or permissive until the person chooses.
  'privacy.cookies': { kind: 'enum', options: ['all', 'blockThirdParty'], default: 'all' },
  'privacy.globalPrivacyControl': { kind: 'bool', default: false },
  'privacy.doNotTrack': { kind: 'bool', default: false },
  'privacy.httpsOnly': { kind: 'bool', default: false },
  'privacy.secureDns': { kind: 'enum', options: ['off', 'automatic', 'cloudflare', 'quad9'], default: 'off' },
  // What a site may do without being asked about it, one default per kind (site-settings/kinds.ts lists them). A site's own answer overrides.
  'sites.camera': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.microphone': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.location': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.clipboardRead': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.midi': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.idle': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.windowManagement': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.notifications': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.devices': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.screenShare': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.autoDownloads': { kind: 'enum', options: ['ask', 'block'], default: 'ask' },
  'sites.popups': { kind: 'enum', options: ['block', 'allow'], default: 'block' },
  'sites.javascript': { kind: 'enum', options: ['allow', 'block'], default: 'allow' },
  'sites.images': { kind: 'enum', options: ['allow', 'block'], default: 'allow' },
  'sites.sound': { kind: 'enum', options: ['allow', 'block'], default: 'allow' },
  // Whether Orivon offers to keep a login a person types, and to fill one they saved.
  'passwords.offerToSave': { kind: 'bool', default: true },
  'passwords.autofill': { kind: 'bool', default: true },
  'autofill.addresses': { kind: 'bool', default: true },
  // Whether Orivon asks GitHub, once a day, if a newer release exists. It never installs anything. Off until the owner decides.
  'updates.check': { kind: 'bool', default: false },
  // Whether `.eth` names are proven by a light client that runs on this computer. Read when Orivon starts.
  'web3.lightClient': { kind: 'bool', default: true },
  // Every tab's page can be inspected unless the person turns it off; where the tools open is theirs too.
  'developer.tools': { kind: 'bool', default: true },
  'developer.dock': { kind: 'enum', options: ['right', 'bottom', 'undocked'], default: 'right' },
  // What a launch opens: the new-tab page, the last session, or a list of pages (one address per line, at most eight).
  'startup.mode': { kind: 'enum', options: ['newTab', 'continue', 'pages'], default: 'newTab' },
  // Room for the most addresses at their longest (2048 each), one per line.
  'startup.pages': { kind: 'text', default: '', maxLength: MAX_LISTED_ADDRESSES * 2049, check: isAddressList },
  // Empty means the new-tab page.
  'home.url': { kind: 'text', default: '', maxLength: 2048, check: isEmptyOrAddress },
  'toolbar.home': { kind: 'bool', default: false },
  // 'auto' shows the button while a download is under way or was recent.
  'toolbar.downloads': { kind: 'enum', options: ['auto', 'always', 'never'], default: 'auto' },
  'spellcheck.enabled': { kind: 'bool', default: true },
  'tabs.lastTabClosed': { kind: 'enum', options: ['closeWindow', 'newTab'], default: 'closeWindow' },
  // Load unpacked, Reload for an unpacked extension: off until the person turns it on.
  'extensions.developerMode': { kind: 'bool', default: false }
} as const satisfies Record<string, SettingSpec>

export type SettingKey = keyof typeof SPECS

type ValueOf<S extends SettingSpec> =
  S extends { readonly kind: 'enum', readonly options: readonly (infer O)[] } ? O
    : S extends { readonly kind: 'bool' } ? boolean
      : S extends { readonly kind: 'int' } ? number
        : string

export type SettingsValues = { readonly [K in SettingKey]: ValueOf<(typeof SPECS)[K]> }
export type SettingValue = string | number | boolean

export const SETTINGS: Readonly<Record<SettingKey, SettingSpec>> = SPECS

export function isSettingKey (key: unknown): key is SettingKey {
  return typeof key === 'string' && Object.hasOwn(SPECS, key)
}

/** The value if `value` is acceptable for `spec`, else undefined. */
export function validateSetting (spec: SettingSpec, value: unknown): SettingValue | undefined {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && spec.options.includes(value) ? value : undefined
    case 'bool':
      return typeof value === 'boolean' ? value : undefined
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max ? value : undefined
    case 'text':
      return typeof value === 'string' && value.length <= spec.maxLength && spec.check?.(value) !== false ? value : undefined
  }
}

/** What the Settings page is told about one setting: no functions, so it can cross IPC. */
export type SettingDescription =
  | { readonly key: SettingKey, readonly kind: 'enum', readonly options: readonly string[], readonly default: string, readonly labels: Readonly<Record<string, string>> }
  | { readonly key: SettingKey, readonly kind: 'bool', readonly default: boolean }
  | { readonly key: SettingKey, readonly kind: 'int', readonly default: number, readonly min: number, readonly max: number }
  | { readonly key: SettingKey, readonly kind: 'text', readonly default: string, readonly maxLength: number }

export function describeSettings (): SettingDescription[] {
  return (Object.keys(SPECS) as SettingKey[]).map((key): SettingDescription => {
    const spec = SETTINGS[key]
    switch (spec.kind) {
      case 'enum': return { key, kind: 'enum', options: spec.options, default: spec.default, labels: spec.labels ?? {} }
      case 'bool': return { key, kind: 'bool', default: spec.default }
      case 'int': return { key, kind: 'int', default: spec.default, min: spec.min, max: spec.max }
      case 'text': return { key, kind: 'text', default: spec.default, maxLength: spec.maxLength }
    }
  })
}
