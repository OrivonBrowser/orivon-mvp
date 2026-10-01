// The search engines as main reports them: the list, which one is the default, and whether that one offers
// suggestions. Changes go to main and come back as `searchEngines.changed`; a change of the default choice
// in settings reaches here as `settings.changed`, so the badge follows it wherever it was made.
import type { EngineView } from '../../../main/browsing/search-resolve.js'
import type { OrivonInternal } from '../shared/bridge.js'
import type { Draft, Refusal } from './engines-form.js'

interface ListReply {
  readonly engines: readonly EngineView[]
  readonly defaultId: string | null
  readonly defaultName: string
  readonly suggestable: boolean
  readonly isPrivate: boolean
}

type Answer = { readonly ok: true } | ({ readonly ok: false } & Refusal)

const isAnswer = (value: unknown): value is Answer => typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'

export class EnginesState {
  engines: readonly EngineView[] = []
  defaultId: string | null = null
  /** The default engine's name, or empty when the default is an address that is none of the engines. */
  defaultName = ''
  suggestable = false
  isPrivate = false

  constructor (private readonly bridge: OrivonInternal, private readonly changed: () => void) {}

  async load (): Promise<void> {
    const reply = await this.bridge.request('searchEngines', { type: 'list' }) as ListReply | undefined
    if (reply === undefined) return
    this.engines = reply.engines
    this.defaultId = reply.defaultId
    this.defaultName = reply.defaultName
    this.suggestable = reply.suggestable
    this.isPrivate = reply.isPrivate
    this.changed()
  }

  /** True when the event was this list's own and has been taken. The settings event is read, never consumed: its own row still needs it. */
  handle (topic: string, payload: unknown): boolean {
    if (topic === 'searchEngines.changed') { void this.load(); return true }
    const key = topic === 'settings.changed' ? (payload as { key?: unknown } | null)?.key : undefined
    if (key === 'search.engine' || key === 'search.customUrl') void this.load()
    return false
  }

  /** Null when main took it, else why not. */
  async add (draft: Draft): Promise<Refusal | null> {
    return await this.send({ type: 'add', ...draft })
  }

  async update (id: string, draft: Draft): Promise<Refusal | null> {
    return await this.send({ type: 'update', id, ...draft })
  }

  async remove (id: string): Promise<Refusal | null> {
    return await this.send({ type: 'remove', id })
  }

  async makeDefault (id: string): Promise<void> {
    await this.send({ type: 'makeDefault', id })
  }

  private async send (command: object): Promise<Refusal | null> {
    const answer = await this.bridge.request('searchEngines', command)
    if (!isAnswer(answer)) return { reason: 'not-found' }
    return answer.ok ? null : answer
  }
}
