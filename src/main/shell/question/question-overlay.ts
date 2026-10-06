// The panel behind every question the browser puts to the person: one
// overlay page, drawn from a spec main holds under a random id. The page names
// a button (and the text or tick it collected); the words, the buttons, which
// of them are guarded and what a way out answers are all read here, never
// taken from the page. `ask-question.ts` is what callers use.
import { randomBytes } from 'node:crypto'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { createKeyQuiet } from '../../overlays/key-quiet.js'
import { slotClosed } from '../../overlays/tab-slots.js'
import type { ShellWindow } from '../window-registry.js'
import { DOUBLE_PRESS_MS, GUARD_MS, MAX_INPUT, viewOf, type QuestionResult, type QuestionSpec, type QuestionView } from './question-spec.js'

/** Anchored by `crossingAnchor`, so its top edge lies inside the toolbar. */
export const QUESTION_OVERLAY = 'question'
/** Centred over the page, where there is no toolbar to cross (a kiosk). */
export const QUESTION_SHEET_OVERLAY = 'question-sheet'

const PANEL_WIDTH = 440

interface Held {
  readonly id: string
  readonly window: ShellWindow
  readonly spec: QuestionSpec
  readonly settle: (result: QuestionResult) => void
}

/** Held in main by a random id: the page is told an id and never a spec it could be made to restate. */
const held = new Map<string, Held>()

/** Holds a spec until it is answered or ends; returns its id. */
export function holdQuestion (window: ShellWindow, spec: QuestionSpec, settle: (result: QuestionResult) => void): string {
  const id = randomBytes(12).toString('hex')
  held.set(id, { id, window, spec, settle })
  return id
}

export function releaseQuestion (id: string): void {
  held.delete(id)
}

export function heldQuestion (id: unknown): Held | undefined {
  return typeof id === 'string' ? held.get(id) : undefined
}

interface Answer { id: string, button: number, text: string | undefined, checkbox: boolean | undefined }

const KEYS = new Set(['id', 'button', 'text', 'checkbox'])

/** Only `{ id, button }` with an optional `text` and `checkbox`, and no other key. */
function asAnswer (command: unknown): Answer | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const record = command as Record<string, unknown>
  if (Object.keys(record).some((key) => !KEYS.has(key))) return undefined
  const { id, button, text, checkbox } = record
  if (typeof id !== 'string' || typeof button !== 'number' || !Number.isInteger(button)) return undefined
  if (text !== undefined && (typeof text !== 'string' || text.length > MAX_INPUT)) return undefined
  if (checkbox !== undefined && typeof checkbox !== 'boolean') return undefined
  return { id, button, text, checkbox }
}

/** The page's report that the question is in its document: `{ type: 'drawn', id }` and nothing else. */
function drawnId (command: unknown): string | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const record = command as Record<string, unknown>
  if (record['type'] !== 'drawn' || Object.keys(record).length !== 2) return undefined
  return typeof record['id'] === 'string' ? record['id'] : undefined
}

interface Arrival { type: 'enter' | 'leave', id: string, button: number }

/** The page's report that the pointer or the keyboard's focus arrived on, or left, a button: `{ type, id, button }` and nothing else. */
function asArrival (command: unknown): Arrival | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const record = command as Record<string, unknown>
  const { type, id, button } = record
  if (Object.keys(record).length !== 3 || (type !== 'enter' && type !== 'leave')) return undefined
  return typeof id === 'string' && typeof button === 'number' && Number.isInteger(button) ? { type, id, button } : undefined
}

function idOf (payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { id } = payload as { id?: unknown }
  return typeof id === 'string' ? id : undefined
}

export function createQuestionPanel (name: string, now: () => number = Date.now): (win: OverlayWindow) => OverlayHandler {
  return ({ window, close, send }) => {
    let shownId: string | null = null
    // The guard counts from the page drawing the question, never from the show: the page loads cold, so the show can come long before anything is on screen.
    let shownAt: number | null = null
    // A key typed at the page when the question appears, or Tab, Tab, Enter at it, must not reach a guarded button: the keyboard has to be quiet for the guard's length too.
    const keys = createKeyQuiet(now)
    // A double-press button answers only once the pointer or the focus has arrived on it after the guard, and then on its second press within DOUBLE_PRESS_MS.
    let armed: number | null = null
    let firstPress: { button: number, at: number } | null = null
    const disarm = (): void => { armed = null; firstPress = null }
    return {
      key: (key) => {
        // Enter and Space press the focused button; any other key leaves a pending double press behind.
        if (key.key !== 'Enter' && key.key !== ' ') disarm()
        // In a question with a text box the keys typed into it are the answer being written: only Tab, which moves
        // the keyboard onto a button, or a held key restarts the wait. The guard from the drawing still stands.
        const answeringInText = shownId !== null && heldQuestion(shownId)?.spec.input !== undefined
        if (answeringInText && key.key !== 'Tab' && !key.isAutoRepeat) return false
        return keys.onKey(key)
      },

      show: (payload): QuestionView | undefined => {
        const entry = heldQuestion(idOf(payload))
        if (entry === undefined || entry.window !== window) { shownId = null; return undefined }
        shownId = entry.id
        shownAt = null
        keys.reset()
        disarm()
        return viewOf(entry.id, entry.spec)
      },

      request: (command) => {
        const drawn = drawnId(command)
        if (drawn !== undefined) {
          if (drawn === shownId && shownAt === null) shownAt = now()
          return true
        }
        const arrival = asArrival(command)
        if (arrival !== undefined) {
          const spec = arrival.id === shownId ? heldQuestion(arrival.id)?.spec : undefined
          if (spec === undefined) return undefined
          if (arrival.type === 'leave') {
            if (armed === arrival.button) disarm()
          } else if (spec.doublePress?.includes(arrival.button) === true && shownAt !== null && now() - shownAt >= GUARD_MS) {
            // Arriving again while armed is the same pointer moving inside the button: the first press stands.
            if (armed !== arrival.button) firstPress = null
            armed = arrival.button
          }
          return true
        }
        const answer = asAnswer(command)
        const entry = answer === undefined || answer.id !== shownId ? undefined : heldQuestion(answer.id)
        if (answer === undefined || entry === undefined) return undefined
        const { spec } = entry
        if (answer.button < 0 || answer.button >= spec.buttons.length) return undefined
        if (spec.guarded?.includes(answer.button) === true && (shownAt === null || now() - shownAt < GUARD_MS || keys.quietFor() < GUARD_MS)) return undefined
        if (spec.doublePress?.includes(answer.button) === true) {
          if (armed !== answer.button) return undefined
          if (firstPress === null || firstPress.button !== answer.button || now() - firstPress.at > DOUBLE_PRESS_MS) {
            firstPress = { button: answer.button, at: now() }
            send({ type: 'pressed', button: answer.button, ms: DOUBLE_PRESS_MS })
            return undefined
          }
        }
        if (answer.text !== undefined && spec.input === undefined) return undefined
        if (answer.checkbox !== undefined && spec.checkboxLabel === undefined) return undefined
        entry.settle({
          response: answer.button,
          checkboxChecked: answer.checkbox === true,
          ...(spec.input === undefined ? {} : { text: answer.text ?? spec.input.initial })
        })
        close()
        return undefined
      },

      // A resize or a layout change moves the panel under the person's pointer: the guard starts over.
      moved: () => {
        if (shownId === null || shownAt === null) return
        shownAt = now()
        disarm()
        send({ type: 'arm' })
      },

      closed: (reason) => {
        shownId = null
        slotClosed(window, name, reason)
      },

      disposed: () => {
        for (const entry of [...held.values()]) if (entry.window === window) entry.settle({ response: entry.spec.cancelId, checkboxChecked: false })
      }
    }
  }
}

const common = {
  surface: 'panel',
  // Focus goes to the panel so a key typed at the page cannot answer it.
  focus: 'take',
  layer: 'bar',
  // A click elsewhere leaves the question open and a tab switch hides it; the ask ends when the tab does.
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { initial: 170, min: 110, max: 460 }
} as const

export const questionOverlay: OverlayDef = {
  ...common,
  name: QUESTION_OVERLAY,
  placement: { kind: 'anchor', width: PANEL_WIDTH, align: 'left' },
  attach: createQuestionPanel(QUESTION_OVERLAY)
}

export const questionSheetOverlay: OverlayDef = {
  ...common,
  name: QUESTION_SHEET_OVERLAY,
  placement: { kind: 'area', at: 'center', width: PANEL_WIDTH },
  attach: createQuestionPanel(QUESTION_SHEET_OVERLAY)
}
