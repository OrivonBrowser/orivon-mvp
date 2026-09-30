// Turns key presses into commands. Runs on `before-input-event`, which fires
// in the browser process before the page sees the key, so a page cannot take
// a browser shortcut and a handled chord never reaches it. The application
// menu is not used for this (on Linux and Windows there is none): a menu
// accelerator can take a key before this sees it, and does not reach every
// view.
import type { WebContents } from 'electron'
import { chordFromInput } from './accelerator.js'
import type { KeyInput } from './accelerator.js'
import { commandById } from './commands.js'
import type { CommandId } from './commands.js'
import type { RecordOutcome, ShortcutService } from './shortcut-service.js'

/** The part of an Electron `Input` this reads. */
export interface PressedKey extends KeyInput {
  readonly type: string
  readonly isAutoRepeat: boolean
  readonly isComposing: boolean
}

export interface DispatcherHost {
  /** The window's commands are held while a page has the screen; `isAppTab`: the contents are a registered app's tab. Null: the contents are in no window. */
  windowFor: (contents: WebContents) => { suspended: boolean, isAppTab: boolean, run: (id: CommandId) => void } | null
  /** A recording finished, for the page that asked. */
  recorded: (contents: WebContents, outcome: RecordOutcome) => void
}

export function attachShortcuts (contents: WebContents, service: ShortcutService, host: DispatcherHost): void {
  contents.on('before-input-event', (event, input: PressedKey) => {
    if (input.type !== 'keyDown' || input.isComposing) return
    const chord = chordFromInput(input)

    // While a page is recording, its next chord is the answer, not a command.
    if (service.isRecording(contents)) {
      if (chord === null) return
      event.preventDefault()
      const outcome = service.recordChord(contents, chord)
      if (outcome !== null) host.recorded(contents, outcome)
      return
    }

    if (chord === null) return
    const id = service.commandFor(chord)
    if (id === null) return
    const target = host.windowFor(contents)
    // A page in fullscreen keeps every key (Escape leaves it, in the browser process).
    if (target === null || target.suspended) return
    // The app has its own version of this key (find, print, save): it gets it, and the browser's stays unused there.
    if (target.isAppTab && commandById(id)?.yieldToApp === true) return
    event.preventDefault()
    if (input.isAutoRepeat && !service.isRepeatable(id)) return
    target.run(id)
  })
}
