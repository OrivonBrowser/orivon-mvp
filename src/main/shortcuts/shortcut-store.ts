// The bindings a person has changed, in <userData>/shortcuts.json. Only a
// change from the default is stored: a command not listed keeps its default,
// and `null` means the person cleared it.
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { parseBinding } from './accelerator.js'
import type { Platform } from './accelerator.js'
import { isCommandId } from './commands.js'
import type { CommandId } from './commands.js'
import { checkBinding } from './rules.js'

const FILE_VERSION = 1

export class ShortcutStore {
  private readonly changed = new Map<CommandId, string | null>()
  private loading: Promise<void> | null = null
  private readonly writer = new DebouncedWriter(async () => { this.writeNow() })

  constructor (private readonly filePath: string, private readonly platform: Platform) {}

  /** Reads the file once. An entry that names no command, or a binding the rules would refuse, is dropped. */
  load (): Promise<void> {
    this.loading ??= this.readFromDisk()
    return this.loading
  }

  private async readFromDisk (): Promise<void> {
    let bindings: unknown
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && (parsed as { version?: unknown }).version === FILE_VERSION) bindings = (parsed as { bindings?: unknown }).bindings
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] shortcuts file unreadable, using the defaults:', error)
      return
    }
    if (typeof bindings !== 'object' || bindings === null) return
    for (const [id, text] of Object.entries(bindings)) {
      if (!isCommandId(id)) continue
      if (text === null) { this.changed.set(id, null); continue }
      const chord = typeof text === 'string' ? parseBinding(text, this.platform) : null
      if (chord !== null && checkBinding(chord, this.platform) === null) this.changed.set(id, text as string)
    }
  }

  /** What the person set: a binding text, `null` for cleared, undefined for untouched. */
  get (id: CommandId): string | null | undefined {
    return this.changed.get(id)
  }

  /** Sets several at once, so a swap is never half done. `undefined` puts a command back to its default. */
  setMany (changes: ReadonlyMap<CommandId, string | null | undefined>): void {
    for (const [id, text] of changes) {
      if (text === undefined) this.changed.delete(id)
      else this.changed.set(id, text)
    }
    this.writer.schedule()
  }

  resetAll (): void {
    this.changed.clear()
    this.writer.schedule()
  }

  async flush (): Promise<void> {
    await this.writer.flush()
  }

  private writeNow (): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: FILE_VERSION, bindings: Object.fromEntries(this.changed) }, null, 2))
    } catch (error) {
      console.error('[orivon] failed to persist shortcuts:', error)
      throw error
    }
  }
}
