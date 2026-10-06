// The questions the screen-share picker is asking: one per share, answered once with a choice or null. Main keeps
// every source here behind a random card id, so what the page sends back names a card main offered and nothing else.
// Pure: no `electron` import.
import { randomBytes } from 'node:crypto'
import type { WebContents } from 'electron'
import type { DisplayChoice, DisplayRequest } from '../types.js'
import type { PickerSegment } from './picker-model.js'

/** What a card stands for, held in main. */
export type CardRef =
  | { readonly kind: 'tab', readonly tab: WebContents }
  | { readonly kind: 'window' | 'screen', readonly source: { readonly id: string, readonly name: string } }
  /** The system dialog lists the sources; it opens when the capture starts, after Share. */
  | { readonly kind: 'portal', readonly segment: 'window' | 'screen' }

export interface Question {
  readonly id: string
  readonly request: DisplayRequest
  readonly owner: object
  readonly tabId: string
  /** Card ids by the key of what they stand for, so a refresh keeps a card's id and the selection survives it. */
  readonly refs: Map<string, CardRef>
  settled: boolean
}

export class PickerStore {
  private readonly questions = new Map<string, { question: Question, resolve: (choice: DisplayChoice | null) => void }>()
  private readonly cardKeys = new WeakMap<Question, Map<string, string>>()

  constructor (private readonly newId: () => string = () => randomBytes(8).toString('hex')) {}

  add (owner: object, tabId: string, request: DisplayRequest): { question: Question, answer: Promise<DisplayChoice | null> } {
    const question: Question = { id: this.newId(), request, owner, tabId, refs: new Map(), settled: false }
    this.cardKeys.set(question, new Map())
    const answer = new Promise<DisplayChoice | null>((resolve) => { this.questions.set(question.id, { question, resolve }) })
    return { question, answer }
  }

  /** The question, for the window and tab it was asked in. */
  get (id: string): Question | undefined {
    return this.questions.get(id)?.question
  }

  /** The id of the card for `key` (what it stands for), made on first use. */
  cardId (question: Question, key: string, ref: CardRef): string {
    const keys = this.cardKeys.get(question)
    let id = keys?.get(key)
    if (id === undefined) {
      id = this.newId()
      keys?.set(key, id)
    }
    question.refs.set(id, ref)
    return id
  }

  /** Answers once; later calls change nothing. */
  settle (id: string, choice: DisplayChoice | null): void {
    const held = this.questions.get(id)
    if (held === undefined) return
    this.questions.delete(id)
    held.question.settled = true
    held.resolve(choice)
  }
}

export const SEGMENT_ORDER: readonly PickerSegment[] = ['tab', 'window', 'screen']
