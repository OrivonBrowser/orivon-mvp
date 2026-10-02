// What the three `*-prompt.ts` files share about the tab that asked: the
// question is drawn in that tab's panel, and its page is held where it is
// while the question is open. A caller with no tab known (an update found in
// the background) asks in the tab in front.
import { holdNavigation } from '../shell/navigation-hold.js'
import { askQuestion } from '../shell/question/ask-question.js'
import type { QuestionResult, QuestionSpec } from '../shell/question/question-spec.js'
import type { DialogCaller } from './request-grant.js'

const contentsOf = (caller: DialogCaller | undefined): object | undefined => caller?.contents?.() as object | undefined

/** Asks in the calling tab's panel. An aborted signal withdraws the question as a cancel. */
export async function askCaller (caller: DialogCaller | undefined, spec: QuestionSpec, signal?: AbortSignal): Promise<QuestionResult> {
  return await askQuestion({ contents: contentsOf(caller) }, spec, signal === undefined ? {} : { signal })
}

/** Holds the calling tab's page until the returned release is called. */
export function holdCaller (caller: DialogCaller | undefined): () => void {
  return holdNavigation(contentsOf(caller))
}
