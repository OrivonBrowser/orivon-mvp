// What the question page accepts from main, checked once at the edge so the
// drawing code can rely on the shape. Anything else closes the panel rather
// than drawing a half-formed question.
import type { QuestionKind, QuestionView } from '../../../main/shell/question/question-spec.js'

const KINDS: readonly string[] = ['consent', 'confirm', 'notice', 'page-alert', 'page-confirm', 'page-prompt']
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'

export function isQuestionView (value: unknown): value is QuestionView {
  if (!isRecord(value)) return false
  const { id, kind, message, buttons, cancelId, guarded, focus, input, guardMs } = value
  return typeof id === 'string' && typeof kind === 'string' && KINDS.includes(kind) && typeof message === 'string' &&
    Array.isArray(buttons) && buttons.length > 0 && buttons.every((label) => typeof label === 'string') &&
    typeof cancelId === 'number' && Array.isArray(guarded) && guarded.every((index) => typeof index === 'number') &&
    Array.isArray(value['doublePress']) && value['doublePress'].every((index) => typeof index === 'number') && typeof value['doublePressMs'] === 'number' &&
    (focus === 'dialog' || typeof focus === 'number') && typeof guardMs === 'number' && typeof value['warning'] === 'boolean' &&
    optionalString(value['title']) && optionalString(value['detail']) && optionalString(value['origin']) && optionalString(value['checkboxLabel']) &&
    (input === undefined || (isRecord(input) && typeof input['initial'] === 'string' && typeof input['max'] === 'number'))
}

/** The kinds a page can raise: drawn as the page's own words, never as the browser's. */
export const isPageQuestion = (kind: QuestionKind): boolean => kind.startsWith('page-')

/** Cancel first, then the rest in the order given: the way out is always on the left, as in every other sheet. */
export function displayOrder (buttons: readonly string[], cancelId: number): number[] {
  const rest = buttons.map((_, index) => index).filter((index) => index !== cancelId)
  return cancelId >= 0 && cancelId < buttons.length ? [cancelId, ...rest] : rest
}

/** The button the strongest style goes to: the first one that is not the way out. */
export function primaryIndex (buttons: readonly string[], cancelId: number): number {
  return displayOrder(buttons, cancelId).find((index) => index !== cancelId) ?? -1
}
