// What the person has told each site, as the site-info popover and the Settings page read and change it: one door
// over the per-site store and the notifications store (a separate file with its own consumers), so a kind lives in
// whichever it lives in and neither surface needs to know. Only kinds that are `available` are ever shown or
// written, and a registered app's origin is never listed or changed here: an app is bounded by its grants, and a
// row that said "Camera allowed" for one would say something the gate does not do. No `electron` import.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { SettingKey } from '../settings/schema.js'
import { SITE_KINDS, type SiteKind, type SiteKindDef, type SiteValue } from './kinds.js'
import type { SiteDecision, SiteSettingsListener } from './site-settings-store.js'

/** What a select offers: the setting's own answer, or a stored one. */
export type SiteChoice = 'default' | 'allow' | 'block'

export interface ChoiceOption { readonly value: SiteChoice, readonly label: string }

/** One kind's row for one site, or for the defaults when `value` is `default`. */
export interface SiteKindRow {
  readonly kind: SiteKind
  readonly label: string
  readonly group: SiteKindDef['group']
  /** What this site has stored, or `default` when it follows the setting. */
  readonly value: SiteChoice
  readonly defaultValue: SiteValue
  readonly options: readonly ChoiceOption[]
}

export interface SiteSummary {
  readonly origin: string
  readonly kinds: ReadonlyArray<{ readonly kind: SiteKind, readonly label: string, readonly value: SiteDecision }>
}

/** A kind's own default, as the Settings page lists it. */
export interface DefaultRow {
  readonly kind: SiteKind
  readonly label: string
  readonly group: SiteKindDef['group']
  readonly settingKey: SettingKey
  readonly options: ReadonlyArray<{ readonly value: SiteValue, readonly label: string }>
}

export interface StoredDecisions {
  get: (origin: string, kind: SiteKind) => SiteDecision | undefined
  set: (origin: string, kind: SiteKind, value: SiteDecision) => void
  forget: (origin: string, kind: SiteKind) => void
  forgetOrigin: (origin: string) => void
  clear: () => void
  entries: () => ReadonlyArray<{ readonly origin: string, readonly kind: SiteKind, readonly value: SiteDecision }>
  onChange: (listener: SiteSettingsListener) => () => void
}

/** The notifications store: answers keyed by origin alone. */
export interface NotificationAnswers {
  get: (origin: string) => SiteDecision | undefined
  set: (origin: string, decision: SiteDecision) => void
  forget: (origin: string) => void
  clear: () => void
  entries: () => ReadonlyArray<{ readonly origin: string, readonly decision: SiteDecision }>
  onChange: (listener: () => void) => () => void
}

export interface SiteSettingsControllerDeps {
  readonly store: StoredDecisions
  readonly notifications: NotificationAnswers
  /** The setting's current value for a kind: where a site with no answer of its own lands. */
  readonly defaultFor: (kind: SiteKindDef) => SiteValue
  /** A registered app, or one served from the cache: bounded by its own grants. */
  readonly isApp: (origin: string) => boolean
  /** The kinds to offer; the table of every kind unless a test says otherwise. */
  readonly kinds?: readonly SiteKindDef[]
}

export interface SiteSettingsController {
  /** One row per available kind for a site; none for an origin that is not an ordinary website. */
  rowsFor: (origin: string) => SiteKindRow[]
  /** Sets a site's answer for a kind; `default` forgets it. False when the request was refused. */
  set: (origin: string, kind: unknown, value: unknown) => boolean
  resetSite: (origin: string) => boolean
  resetAll: () => void
  /** Every site with an answer of its own, by site. */
  sites: () => SiteSummary[]
  defaults: () => DefaultRow[]
  /** `origin` is the site that changed, or null when many did. Returns the removal. */
  onChange: (listener: SiteSettingsListener) => () => void
}

/** One word for each state wherever it is chosen: a default, a site's own answer, the review bubble. A badge says it in the past tense instead. */
const VALUE_WORD: Readonly<Record<SiteValue, string>> = { ask: 'Ask', allow: 'Allow', block: 'Block' }
const CHOICES: readonly SiteChoice[] = ['default', 'allow', 'block']
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** An ordinary website's origin: `http(s)` and exactly what the gate itself would derive. */
export function isWebOrigin (origin: unknown): origin is string {
  return typeof origin === 'string' && /^https?:\/\//.test(origin) && originFromUrl(origin) === origin
}

const hostOf = (origin: string): string => origin.replace(/^https?:\/\//, '')

export function createSiteSettingsController (deps: SiteSettingsControllerDeps): SiteSettingsController {
  const kinds = (deps.kinds ?? SITE_KINDS).filter((kind) => kind.available)
  const byId = new Map<string, SiteKindDef>(kinds.map((kind) => [kind.id, kind]))
  const { store, notifications } = deps

  /** The setting's value, held to the kind's own choices. */
  const defaultOf = (kind: SiteKindDef): SiteValue => {
    const value = deps.defaultFor(kind)
    return kind.values.includes(value) ? value : (kind.values[0] ?? 'ask')
  }

  const stored = (origin: string, kind: SiteKind): SiteDecision | undefined =>
    kind === 'notifications' ? notifications.get(origin) : store.get(origin, kind)

  function optionsFor (current: SiteChoice, defaultValue: SiteValue): ChoiceOption[] {
    const options: ChoiceOption[] = [{ value: 'default', label: `Use default (${VALUE_WORD[defaultValue]})` }]
    for (const decision of ['allow', 'block'] as const) {
      // A choice that says what "default" already says is offered only while it is what is stored.
      if (decision !== defaultValue || current === decision) options.push({ value: decision, label: VALUE_WORD[decision] })
    }
    return options
  }

  function rowFor (origin: string, kind: SiteKindDef): SiteKindRow {
    const value = stored(origin, kind.id) ?? 'default'
    const defaultValue = defaultOf(kind)
    return { kind: kind.id, label: kind.label, group: kind.group, value, defaultValue, options: optionsFor(value, defaultValue) }
  }

  return {
    rowsFor: (origin) => !isWebOrigin(origin) || deps.isApp(origin) ? [] : kinds.map((kind) => rowFor(origin, kind)),

    set (origin, kind, value) {
      const def = typeof kind === 'string' ? byId.get(kind) : undefined
      if (def === undefined || !isWebOrigin(origin) || deps.isApp(origin) || !CHOICES.includes(value as SiteChoice)) return false
      const choice = value as SiteChoice
      if (def.id === 'notifications') {
        if (choice === 'default') notifications.forget(origin)
        else notifications.set(origin, choice)
      } else if (choice === 'default') {
        store.forget(origin, def.id)
      } else {
        store.set(origin, def.id, choice)
      }
      return true
    },

    resetSite (origin) {
      if (!isWebOrigin(origin)) return false
      store.forgetOrigin(origin)
      notifications.forget(origin)
      return true
    },

    resetAll () {
      store.clear()
      notifications.clear()
    },

    sites () {
      const found = new Map<string, Map<SiteKind, SiteDecision>>()
      const add = (origin: string, kind: SiteKind, value: SiteDecision): void => {
        if (!byId.has(kind) || !isWebOrigin(origin) || deps.isApp(origin)) return
        const answers = found.get(origin) ?? new Map<SiteKind, SiteDecision>()
        answers.set(kind, value)
        found.set(origin, answers)
      }
      for (const entry of store.entries()) add(entry.origin, entry.kind, entry.value)
      for (const entry of notifications.entries()) add(entry.origin, 'notifications', entry.decision)
      const order = kinds.map((kind) => kind.id)
      return [...found]
        .map(([origin, answers]) => ({
          origin,
          kinds: order.filter((kind) => answers.has(kind)).map((kind) => ({ kind, label: byId.get(kind)?.label ?? kind, value: answers.get(kind) as SiteDecision }))
        }))
        .sort((a, b) => collator.compare(hostOf(a.origin), hostOf(b.origin)) || collator.compare(a.origin, b.origin))
    },

    defaults: () => kinds.map((kind) => ({
      kind: kind.id,
      label: kind.label,
      group: kind.group,
      settingKey: kind.settingKey,
      options: kind.values.map((value) => ({ value, label: VALUE_WORD[value] }))
    })),

    onChange (listener) {
      const offStore = store.onChange(listener)
      const offNotifications = notifications.onChange(() => { listener(null) })
      return () => { offStore(); offNotifications() }
    }
  }
}
