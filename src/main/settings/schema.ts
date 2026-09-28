// Every setting, in one place: its default, and what a value must be to be
// accepted. The store validates against this and the Settings page is told
// this, so the page cannot offer a value the store would refuse and a file
// edited by hand cannot make one up.
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
  'search.engine': {
    kind: 'enum',
    options: [...SEARCH_ENGINES.map((engine) => engine.id), CUSTOM_SEARCH_ENGINE],
    default: DEFAULT_SEARCH_ENGINE,
    labels: { ...Object.fromEntries(SEARCH_ENGINES.map((engine) => [engine.id, engine.label])), [CUSTOM_SEARCH_ENGINE]: 'Custom' }
  },
  'search.customUrl': { kind: 'text', default: '', maxLength: 2048, check: (value) => value === '' || isValidSearchTemplate(value) },
  'tabs.lastTabClosed': { kind: 'enum', options: ['closeWindow', 'newTab'], default: 'closeWindow' }
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
