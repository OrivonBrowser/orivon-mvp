// Where each granted app was last used, in <userData>/app-use.json. A private session passes no path and keeps it in
// memory. Read once, synchronously: the first new tab asks for it at once.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { forgetSince, noteUse, parseUse, serializeUse, type AppUseState } from './app-use-state.js'

export class AppUseStore {
  private state: AppUseState | undefined

  constructor (private readonly filePath: string | null) {}

  get (): AppUseState {
    this.state ??= this.read()
    return this.state
  }

  note (origin: string, icon: string | null, now: number): void {
    this.change(noteUse(this.get(), origin, icon, now))
  }

  /** The person cleared their history back to `from` (0 for all of it). */
  forgetSince (from: number): void {
    this.change(forgetSince(this.get(), from))
  }

  private change (next: AppUseState): void {
    if (next === this.get()) return
    this.state = next
    this.write()
  }

  private read (): AppUseState {
    if (this.filePath === null) return {}
    try {
      return parseUse(JSON.parse(readFileSync(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] the app-use file is unreadable, starting from none:', error)
      return {}
    }
  }

  /** Never throws: the use already holds in memory for this run. */
  private write (): void {
    if (this.filePath === null) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, serializeUse(this.get()))
    } catch (error) {
      console.error('[orivon] could not save when apps were last used:', error)
    }
  }
}
