// The questions a chooser sheet is asking: one per call of `askChooser`, each answered once with the id of one
// offered row or null. Pure: no `electron` import. What a caller hands in is cut down to what a row can show.
import { randomBytes } from 'node:crypto'

export interface ChooserItem {
  readonly id: string
  readonly title: string
  readonly sub?: string | undefined
  readonly meta?: string | undefined
  /** The row is out of date: drawn as a problem and listed after the others, and choosing it is warned about. */
  readonly expired?: boolean | undefined
}

export interface ChooserSpec {
  readonly title: string
  /** The site or device the question is about, drawn as the sheet's origin line. */
  readonly origin?: string | undefined
  readonly line?: string | undefined
  /** A caution about who is asking, drawn above the list. */
  readonly warning?: string | undefined
  /** Whether a lone row starts selected; false when confirming must always be a deliberate choice. Default true. */
  readonly preselect?: boolean | undefined
  /** The primary button's label. */
  readonly confirm: string
  /** What the sheet says when `items` is empty. */
  readonly empty: string
  readonly items: readonly ChooserItem[]
}

/** What the page draws; every string is capped and every id is unique. */
export interface ChooserView {
  readonly id: string
  readonly title: string
  readonly origin: string | null
  readonly line: string | null
  readonly warning: string | null
  readonly preselect: boolean
  readonly confirm: string
  readonly empty: string
  readonly items: readonly ChooserItem[]
}

export const MAX_ITEMS = 100
const MAX_TEXT = 200

const cut = (text: string | undefined): string | undefined => text === undefined || text === '' ? undefined : text.slice(0, MAX_TEXT)

interface Question {
  readonly view: ChooserView
  readonly owner: object
  readonly tabId: string
  readonly resolve: (choice: string | null) => void
}

export class ChooserStore {
  private readonly questions = new Map<string, Question>()

  constructor (private readonly newId: () => string = () => randomBytes(8).toString('hex')) {}

  add (owner: object, tabId: string, spec: ChooserSpec): { id: string, answer: Promise<string | null> } {
    const seen = new Set<string>()
    const items: ChooserItem[] = []
    for (const item of spec.items) {
      if (items.length >= MAX_ITEMS) break
      const id = item.id.slice(0, 64)
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const sub = cut(item.sub)
      const meta = cut(item.meta)
      items.push({
        id,
        title: item.title.slice(0, MAX_TEXT),
        ...(sub === undefined ? {} : { sub }),
        ...(meta === undefined ? {} : { meta }),
        ...(item.expired === true ? { expired: true } : {})
      })
    }
    const id = this.newId()
    const view: ChooserView = {
      id,
      title: spec.title.slice(0, MAX_TEXT),
      origin: cut(spec.origin) ?? null,
      line: cut(spec.line) ?? null,
      warning: cut(spec.warning) ?? null,
      preselect: spec.preselect !== false,
      confirm: spec.confirm.slice(0, 40),
      empty: spec.empty.slice(0, MAX_TEXT),
      items
    }
    const answer = new Promise<string | null>((resolve) => { this.questions.set(id, { view, owner, tabId, resolve }) })
    return { id, answer }
  }

  /** The question, for the window and tab it was asked in. */
  get (id: string): { view: ChooserView, owner: object, tabId: string } | undefined {
    return this.questions.get(id)
  }

  /** Answers once; an id the sheet never offered is refused and leaves the question open. */
  resolve (id: string, choice: string | null): boolean {
    const question = this.questions.get(id)
    if (question === undefined) return false
    if (choice !== null && !question.view.items.some((item) => item.id === choice)) return false
    this.questions.delete(id)
    question.resolve(choice)
    return true
  }
}

export const choosers = new ChooserStore()
