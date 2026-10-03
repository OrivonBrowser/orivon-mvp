// What the Settings page may ask of the search engines: read the list, add, edit and remove the person's own,
// and make one the default. The requests are data from a document, so every field is checked here and the store
// judges the rest; nothing in a reply is an address the page could be made to act on.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { SettingsStore } from '../settings/settings-store.js'
import { CUSTOM_SEARCH_ENGINE, defaultTemplate, SEARCH_ENGINES } from './search-engines.js'
import type { EngineDraft } from './search-engine-rules.js'
import type { SearchEngineStore, StoreResult } from './search-engine-store.js'

interface EngineRequest {
  readonly type?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly keyword?: unknown
  readonly template?: unknown
}

/** Far past any valid field, so a document cannot hand a megabyte string to the rules. */
const MAX_FIELD = 4096

export interface EnginesHost {
  readonly isPrivate: boolean
}

function draftFrom (request: EngineRequest): EngineDraft | null {
  const { name, keyword, template } = request
  const fields = [name, keyword, template]
  if (!fields.every((field): field is string => typeof field === 'string' && field.length <= MAX_FIELD)) return null
  return { name: fields[0] as string, keyword: fields[1] as string, template: fields[2] as string }
}

const idFrom = (request: EngineRequest): string | null => typeof request.id === 'string' && request.id.length <= 64 ? request.id : null

function outcome (result: StoreResult): { ok: true } | { ok: false, field?: string, reason: string, usedBy?: string } {
  if (result.ok) return { ok: true }
  return { ok: false, ...(result.field === undefined ? {} : { field: result.field }), reason: result.reason, ...(result.usedBy === undefined ? {} : { usedBy: result.usedBy }) }
}

export function searchEnginesDomain (store: SearchEngineStore, settings: SettingsStore, host: EnginesHost): InternalDomain {
  const current = (): string => defaultTemplate(settings.get('search.engine'), settings.get('search.customUrl'))

  const list = (): unknown => {
    const engines = store.all()
    const template = current()
    const defaultEngine = engines.find((engine) => engine.template === template)
    return {
      engines,
      defaultId: defaultEngine?.id ?? null,
      defaultName: defaultEngine?.name ?? '',
      suggestable: SEARCH_ENGINES.some((engine) => engine.id === defaultEngine?.id && engine.suggestUrl !== undefined),
      isPrivate: host.isPrivate
    }
  }

  const makeDefault = (id: string): unknown => {
    const engine = store.get(id)
    if (engine === undefined) return { ok: false, reason: 'not-found' }
    if (engine.kind === 'builtin') {
      settings.set('search.engine', engine.id)
    } else {
      settings.set('search.customUrl', engine.template)
      settings.set('search.engine', CUSTOM_SEARCH_ENGINE)
    }
    return { ok: true }
  }

  /** An engine that is the default and is removed takes its place as the default with it: searches go to the built-in default. */
  const dropDefault = (template: string): void => {
    if (settings.get('search.engine') !== CUSTOM_SEARCH_ENGINE || settings.get('search.customUrl') !== template) return
    settings.reset('search.engine')
    settings.reset('search.customUrl')
  }

  /** An engine that is the default and whose address changes keeps being the default at its new address. */
  const followDefault = (before: string, after: string): void => {
    if (settings.get('search.engine') === CUSTOM_SEARCH_ENGINE && settings.get('search.customUrl') === before && before !== after) settings.set('search.customUrl', after)
  }

  return {
    pages: ['settings'],
    handle: (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as EngineRequest
      const id = idFrom(request)
      switch (request.type) {
        case 'list':
          return list()
        case 'add': {
          const draft = draftFrom(request)
          return draft === null ? { ok: false, reason: 'required' } : outcome(store.add(draft))
        }
        case 'update': {
          const draft = draftFrom(request)
          if (id === null || draft === null) return { ok: false, reason: 'not-found' }
          const before = store.get(id)?.template
          const result = store.update(id, draft)
          if (result.ok && before !== undefined) followDefault(before, result.engine.template)
          return outcome(result)
        }
        case 'remove': {
          if (id === null) return { ok: false, reason: 'not-found' }
          const gone = store.get(id)?.template
          const result = store.remove(id)
          if (result.ok && gone !== undefined) dropDefault(gone)
          return outcome(result)
        }
        case 'makeDefault':
          return id === null ? { ok: false, reason: 'not-found' } : makeDefault(id)
        default:
          return undefined
      }
    }
  }
}
