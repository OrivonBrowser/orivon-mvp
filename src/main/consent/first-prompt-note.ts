// The one line the first capability question a profile ever shows carries above its buttons. `take` is true the first time
// it is asked in a profile and never again, and the answer is kept in <userData>/consent-notes.json (memory only in a
// private session). The question is taken when it is shown, not when it is answered, so a question left open still counts.
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'

export const FIRST_PROMPT_LINE = 'This is a desktop app. It needs more than a web page may have, so it asks you once.'

const FILE_VERSION = 1

export class FirstPromptNote {
  private shown: boolean

  /** `filePath` null keeps the record in memory. A file that is missing or cannot be read is a profile that has seen none. */
  constructor (private readonly filePath: string | null) {
    this.shown = filePath !== null && readShown(filePath)
  }

  take (): boolean {
    if (this.shown) return false
    this.shown = true
    this.persist()
    return true
  }

  /** Never throws: the note already counts for this run. */
  private persist (): void {
    if (this.filePath === null) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileAtomic(this.filePath, JSON.stringify({ version: FILE_VERSION, firstPromptShown: true }))
    } catch (error) {
      console.error('[orivon] could not save that the first permission question was shown:', error)
    }
  }
}

function readShown (filePath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['version'] === FILE_VERSION && (parsed as Record<string, unknown>)['firstPromptShown'] === true
  } catch {
    return false
  }
}

let installed: FirstPromptNote | undefined

/** The process's note. The first one installed stays, so every subsystem that asks may install the same one. */
export function installFirstPromptNote (note: FirstPromptNote): void {
  installed ??= note
}

/** Whether the question about to be shown is the first of the profile; false while no note is installed. */
export function takeFirstPromptNote (): boolean {
  return installed?.take() ?? false
}

/** `detail` with the line before its last line when that is the address (the panel names the address in its header and drops it), else at the end. */
export function withFirstPromptLine (detail: string, displayOrigin: string): string {
  const lines = detail.split('\n')
  if (lines[lines.length - 1]?.trim() === displayOrigin) lines.splice(lines.length - 1, 0, FIRST_PROMPT_LINE)
  else lines.push(FIRST_PROMPT_LINE)
  return lines.join('\n')
}
