// Turns key presses into commands. Runs on `before-input-event`, which fires
// in the browser process before the page sees the key, so a page cannot take
// a browser shortcut and a handled chord never reaches it. The application
// menu is not used for this (on Linux and Windows there is none): a menu
// accelerator can take a key before this sees it, and does not reach every
// view.
import type { WebContents } from 'electron'
import { chordFromInput } from './accelerator.js'
import type { Chord, KeyInput } from './accelerator.js'
import { commandById } from './commands.js'
import type { CommandId } from './commands.js'
import type { RecordOutcome, ShortcutService } from './shortcut-service.js'

/** The part of an Electron `Input` this reads. */
export interface PressedKey extends KeyInput {
  readonly type: string
  readonly isAutoRepeat: boolean
  readonly isComposing: boolean
}

/** The keys that extensions' commands hold. Orivon's own commands are asked first; these only get a chord none of them holds. */
export interface ExtensionKeys {
  /** A page is waiting to learn which key a person picks for one of an extension's commands. */
  isRecording: (contents: WebContents) => boolean
  record: (contents: WebContents, chord: Chord) => void
  handles: (chord: Chord) => boolean
  /** True when the chord ran a command, so the page never sees it. */
  run: (chord: Chord, contents: WebContents) => boolean
}

export interface DispatcherHost {
  /** The window's commands are held while a page has the screen; `isAppTab`: the contents are a registered app's tab. `alive`: false once the window is closing or gone, which a command waiting for the end of the key event checks. Null: the contents are in no window. */
  windowFor: (contents: WebContents) => { suspended: boolean, isAppTab: boolean, run: (id: CommandId) => void, alive?: () => boolean } | null
  /** A recording finished, for the page that asked. */
  recorded: (contents: WebContents, outcome: RecordOutcome) => void
  extensionKeys?: ExtensionKeys | undefined
}

export function attachShortcuts (contents: WebContents, service: ShortcutService, host: DispatcherHost): void {
  contents.on('before-input-event', (event, input: PressedKey) => {
    if (input.type !== 'keyDown' || input.isComposing) return
    const chord = chordFromInput(input)

    // While a page is recording, its next chord is the answer, not a command.
    const keys = host.extensionKeys
    if (keys?.isRecording(contents) === true) {
      if (chord === null) return
      event.preventDefault()
      keys.record(contents, chord)
      return
    }
    if (service.isRecording(contents)) {
      if (chord === null) return
      event.preventDefault()
      const outcome = service.recordChord(contents, chord)
      if (outcome !== null) host.recorded(contents, outcome)
      return
    }

    if (chord === null) return
    const id = service.commandFor(chord)
    if (id === null) {
      // A held-down key never repeats an extension's command, and a page in fullscreen keeps every key.
      if (keys === undefined || input.isAutoRepeat || !keys.handles(chord)) return
      const owner = host.windowFor(contents)
      // A registered app keeps every key for itself, an extension's included.
      if (owner !== null && !owner.suspended && !owner.isAppTab && keys.run(chord, contents)) event.preventDefault()
      return
    }
    const target = host.windowFor(contents)
    // A page in fullscreen keeps every key (Escape leaves it, in the browser process).
    if (target === null || target.suspended) return
    // The app has its own version of this key (find, print, save): it gets it, and the browser's stays unused there.
    const def = commandById(id)
    if (target.isAppTab && def?.yieldToApp === true) return
    // A reserved command has nothing to run, so taking its chord would only stop the page's own handler for it.
    if (def?.pending === true) return
    event.preventDefault()
    if (input.isAutoRepeat && !service.isRepeatable(id)) return
    // A command can close the developer tools (directly, or by closing, moving or closing others on a tab that has
    // them open), and their webContents is destroyed at once: if Chromium is still notifying observers while this
    // event is delivered, `~WebContentsImpl` answers with a CHECK that ends the main process. Running the command
    // once the event has returned takes every such path out of the delivery.
    setImmediate(() => { if (target.alive?.() !== false) target.run(id) })
  })
}
