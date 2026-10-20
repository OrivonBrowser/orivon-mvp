// The Featured row's choices for one profile, in <userData>/new-tab.json. A private session passes no path and keeps
// them in memory. Read once, synchronously: the file is a few bytes and the first tab asks for it at once.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { giveNewcomerPin, hideTile, parseState, serializeState, showHidden, unpinTile, type FeaturedState } from './featured-state.js'

export class FeaturedStore {
  private state: FeaturedState | undefined

  constructor (private readonly filePath: string | null) {}

  get (): FeaturedState {
    this.state ??= this.read()
    return this.state
  }

  /** Puts `appIdOrUrl` (an app's id, or its address) first in this profile's Featured row, and reports whether it did. It does nothing once the profile was given a pin, whether the person kept it or removed it. */
  setNewcomerPin (appIdOrUrl: string): boolean {
    const before = this.get()
    this.change(giveNewcomerPin(before, appIdOrUrl))
    return this.get() !== before
  }

  hide (id: string): void { this.change(hideTile(this.get(), id)) }
  unpin (id: string): void { this.change(unpinTile(this.get(), id)) }
  showHidden (): void { this.change(showHidden(this.get())) }

  private change (next: FeaturedState): void {
    if (next === this.get()) return
    this.state = next
    this.write()
  }

  private read (): FeaturedState {
    if (this.filePath === null) return parseState(null)
    try {
      return parseState(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] the new-tab file is unreadable, starting from none:', error)
      return parseState(null)
    }
  }

  /** Never throws: the choice already holds in memory for this run. */
  private write (): void {
    if (this.filePath === null) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, serializeState(this.get()))
    } catch (error) {
      console.error('[orivon] could not save the new-tab choices:', error)
    }
  }
}
