// What a question to the person is, as data: the spec a caller hands to
// `askQuestion`, the view the panel is drawn from, and the cleaning every
// string passes through on the way. No `electron` import, so it is unit
// tested without a window and survives an engine change.

/** `consent` and `confirm` change what a page or app may do or hold; `notice` only informs; the `page-*` kinds are a page's own alert, confirm and prompt, drawn in a style a page cannot dress up as a grant. */
export type QuestionKind = 'consent' | 'confirm' | 'notice' | 'page-alert' | 'page-confirm' | 'page-prompt'

export interface QuestionSpec {
  readonly kind: QuestionKind
  readonly title?: string
  readonly message: string
  /** Extra lines under the message, shown as written: a `\n` is a line break. */
  readonly detail?: string
  /** Draws the panel in the warning style. */
  readonly warning?: boolean
  /** The site or app the question is about, computed in main from a committed address, never from page text. */
  readonly origin?: string
  /** Left to right, at most MAX_BUTTONS. */
  readonly buttons: readonly string[]
  /** The index every way out but a click answers with: Escape, a closed tab, a navigation, an abort. */
  readonly cancelId: number
  /** Indexes that ignore the person for GUARD_MS after every show. */
  readonly guarded?: readonly number[]
  /** `dialog` starts on the panel itself, so a key meant for the page lands on no button; a number starts on that button. */
  readonly focus?: 'dialog' | number
  /** A text box, for a page's `prompt()`. */
  readonly input?: { readonly initial: string }
  readonly checkboxLabel?: string
}

/** The same shape as Electron's `MessageBoxReturnValue`, so a call site swaps one call for the other. */
export interface QuestionResult {
  readonly response: number
  readonly checkboxChecked: boolean
  readonly text?: string
}

/** What the panel's page is told on each show; main alone decides every field. */
export interface QuestionView {
  readonly id: string
  readonly kind: QuestionKind
  readonly title: string | undefined
  readonly message: string
  readonly detail: string | undefined
  readonly warning: boolean
  readonly origin: string | undefined
  readonly buttons: readonly string[]
  readonly cancelId: number
  readonly guarded: readonly number[]
  readonly focus: 'dialog' | number
  readonly input: { readonly initial: string, readonly max: number } | undefined
  readonly checkboxLabel: string | undefined
  readonly guardMs: number
}

/** A guarded button ignores clicks and keys for this long after the panel appears, so a click or key meant for the page cannot land on it. */
export const GUARD_MS = 500
export const MAX_BUTTONS = 4
/** The longest text a question's box holds: what a page's own request may carry, so a page's default comes back whole. */
export const MAX_INPUT = 100_000

const MAX_LABEL = 60
const MAX_TITLE = 120
const MAX_ORIGIN = 300
const MAX_MESSAGE = 2000
const MAX_DETAIL = 4000
const MAX_PAGE_MESSAGE = 1000
const MAX_PAGE_LINES = 12

/** Bidirectional controls: they reorder what is drawn around them, so a page could make its text read as another's. */
const BIDI = /[؜‎‏‪-‮⁦-⁩]/gu
const CONTROLS = /\p{Cc}/gu

/** Line ends unified, bidi marks and every control but newline and tab removed. */
function strip (text: string): string {
  return text.replace(/\r\n?/gu, '\n').replace(BIDI, '').replace(CONTROLS, (char) => char === '\n' || char === '\t' ? char : '')
}

function cut (text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join('')}...`
}

/** Text a caller wrote: controls and bidi marks gone, length capped; line breaks stay. */
export function cleanText (text: string, max: number): string {
  return cut(strip(text), max)
}

/** Text a page wrote: cleaned as `cleanText`, and also capped in lines, so a page cannot push the buttons off the panel. */
export function sanitizePageText (text: string, maxLength = MAX_PAGE_MESSAGE, maxLines = MAX_PAGE_LINES): string {
  const lines = strip(text).split('\n')
  const kept = lines.length > maxLines ? [...lines.slice(0, maxLines - 1), '...'] : lines
  return cut(kept.join('\n'), maxLength)
}

export const isPageKind = (kind: QuestionKind): boolean => kind.startsWith('page-')

/** True for the kinds that change what is allowed: they need the toolbar in view, so the person sees where the question comes from. */
export const needsToolbar = (spec: Pick<QuestionSpec, 'kind'>): boolean => spec.kind === 'consent' || spec.kind === 'confirm'

const inRange = (index: number, length: number): boolean => Number.isInteger(index) && index >= 0 && index < length

/** The spec with every string cleaned and every index kept inside the buttons. Throws on a spec with no button to answer with. */
export function normaliseSpec (spec: QuestionSpec): QuestionSpec {
  const buttons = spec.buttons.slice(0, MAX_BUTTONS).map((label) => cleanText(label, MAX_LABEL))
  if (buttons.length === 0) throw new Error('a question needs at least one button')
  const page = isPageKind(spec.kind)
  const clean = (text: string, max: number): string => page ? sanitizePageText(text, max) : cleanText(text, max)
  const wanted = spec.focus ?? (needsToolbar(spec) ? 'dialog' : 0)
  return {
    kind: spec.kind,
    ...(spec.title === undefined ? {} : { title: cleanText(spec.title, MAX_TITLE) }),
    message: clean(spec.message, page ? MAX_PAGE_MESSAGE : MAX_MESSAGE),
    ...(spec.detail === undefined ? {} : { detail: clean(spec.detail, page ? MAX_PAGE_MESSAGE : MAX_DETAIL) }),
    ...(spec.warning === true ? { warning: true } : {}),
    ...(spec.origin === undefined ? {} : { origin: cleanText(spec.origin, MAX_ORIGIN) }),
    buttons,
    cancelId: inRange(spec.cancelId, buttons.length) ? spec.cancelId : buttons.length - 1,
    guarded: [...new Set(spec.guarded ?? [])].filter((index) => inRange(index, buttons.length)),
    focus: wanted === 'dialog' || inRange(wanted, buttons.length) ? wanted : 'dialog',
    ...(spec.input === undefined ? {} : { input: { initial: cleanText(spec.input.initial, MAX_INPUT) } }),
    ...(spec.checkboxLabel === undefined ? {} : { checkboxLabel: cleanText(spec.checkboxLabel, MAX_LABEL) })
  }
}

/**
 * The panel names the origin once, in its header. A native box has no header, so a caller writes the origin
 * as the title and as the last detail line too; those two copies are dropped here and nowhere else.
 */
function withoutRepeatedOrigin (spec: QuestionSpec): { title: string | undefined, detail: string | undefined } {
  const { origin, title, detail } = spec
  if (origin === undefined || isPageKind(spec.kind)) return { title, detail }
  const lines = detail?.split('\n')
  while (lines !== undefined && lines.length > 0 && lines[lines.length - 1]?.trim() === origin) lines.pop()
  const remaining = lines?.join('\n').trimEnd()
  return {
    title: title?.trim() === origin ? undefined : title,
    detail: remaining === undefined || remaining === '' ? undefined : remaining
  }
}

/** The view the panel's page is drawn from. */
export function viewOf (id: string, spec: QuestionSpec): QuestionView {
  const { title, detail } = withoutRepeatedOrigin(spec)
  return {
    id,
    kind: spec.kind,
    title,
    message: spec.message,
    detail,
    warning: spec.warning === true,
    origin: spec.origin,
    buttons: spec.buttons,
    cancelId: spec.cancelId,
    guarded: spec.guarded ?? [],
    focus: spec.focus ?? 'dialog',
    input: spec.input === undefined ? undefined : { initial: spec.input.initial, max: MAX_INPUT },
    checkboxLabel: spec.checkboxLabel,
    guardMs: GUARD_MS
  }
}
