// What Settings keeps about graphics: whether this Orivon runs on an X11 session (where the WebGPU choice is offered) and
// the last time Orivon turned that choice off by itself. Both are main's to say; this asks, and asks again when main says
// the answer changed.
import type { OrivonInternal } from '../shared/bridge.js'
import type { SettingsPart } from './settings-parts.js'

export type RevertWhy = 'gpu-crash' | 'gpu-software' | 'no-window'

export interface Reverted {
  /** When, as an ISO date. */
  readonly at: string
  readonly why: RevertWhy
}

interface OfferReply { readonly offered?: unknown, readonly revert?: unknown }

/** An answer that is not exactly main's shape offers nothing: a row is never shown on a guess. */
export function offerOf (reply: unknown): { readonly offered: boolean, readonly revert: Reverted | null } {
  const { offered, revert } = typeof reply === 'object' && reply !== null ? reply as OfferReply : {} as OfferReply
  const { at, why } = typeof revert === 'object' && revert !== null ? revert as { at?: unknown, why?: unknown } : { at: undefined, why: undefined }
  const known: RevertWhy | undefined = why === 'gpu-crash' || why === 'gpu-software' || why === 'no-window' ? why : undefined
  return { offered: offered === true, revert: typeof at === 'string' && known !== undefined ? { at, why: known } : null }
}

export class GraphicsPart implements SettingsPart {
  offered = false
  revert: Reverted | null = null

  constructor (private readonly bridge: OrivonInternal, private readonly notify: () => void) {}

  async load (): Promise<void> {
    await this.refresh()
  }

  /** Main changed the answer (a revert, or the choice turned on again): read it again. */
  handle (topic: string): boolean {
    if (topic !== 'graphics.changed') return false
    void this.refresh().then(this.notify, () => {})
    return true
  }

  private async refresh (): Promise<void> {
    const answer = offerOf(await this.bridge.request('graphics', { type: 'x11Vulkan' }))
    this.offered = answer.offered
    this.revert = answer.revert
  }
}
