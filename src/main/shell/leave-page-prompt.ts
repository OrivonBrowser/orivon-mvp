// The "Leave this page?" question a page's beforeunload handler asks for.
// Chromium raises it only after the person has interacted with the page, so
// a page cannot hold anyone on it who never touched it.
//
// Electron settles the unload from `will-prevent-unload` itself, with no way to
// answer later, so the question cannot hold the event open. Instead the page
// stays (the event is left alone), the question is asked in the panel, and
// "Leave" lets the next attempt through unasked. A navigation the shell started
// (the address bar, back, forward, reload) is remembered and run again on
// "Leave"; one the page started (a link, a script) has nothing to run again, so
// the person repeats it.
import type { WebContents } from 'electron'
import { askQuestion, type AskQuestion } from './question/ask-question.js'

const LEAVE = 0
const STAY = 1

/** A shell navigation is the one a beforeunload refusal belongs to only if the refusal comes this soon after it. */
const INTENT_MS = 2000
/** "Leave" lets one attempt through for this long; a person who then does nothing is not leaving. */
const APPROVAL_MS = 20_000

const intents = new WeakMap<WebContents, { at: number, run: () => void }>()
const approvals = new WeakMap<WebContents, number>()
const asking = new WeakSet<WebContents>()

/** Runs a navigation the shell started, remembering how to run it again if the page asks the person first. */
export function startNavigation (contents: WebContents, go: () => void): void {
  intents.set(contents, { at: Date.now(), run: go })
  go()
}

/** A new document is on its way: whatever was remembered ran, and is not for a later question. */
export function forgetNavigation (contents: WebContents): void {
  intents.delete(contents)
}

/** What `will-prevent-unload` does: true to let the page go (call `preventDefault`), false to keep it, with the question asked meanwhile. */
export function leaveAllowed (contents: WebContents, ask: AskQuestion = askQuestion): boolean {
  const until = approvals.get(contents)
  const recent = intents.get(contents)
  intents.delete(contents)
  if (until !== undefined) {
    approvals.delete(contents)
    if (until > Date.now()) return true
  }
  if (asking.has(contents)) return false
  const replay = recent !== undefined && Date.now() - recent.at < INTENT_MS ? recent.run : undefined
  asking.add(contents)
  ask({ contents }, {
    kind: 'confirm',
    message: 'Leave this page?',
    detail: 'Changes you made may not be saved.',
    buttons: ['Leave', 'Stay'],
    cancelId: STAY,
    guarded: [LEAVE],
    focus: STAY
  }, { endOnNavigation: true }).then((result) => {
    asking.delete(contents)
    if (result.response !== LEAVE || contents.isDestroyed()) return
    approvals.set(contents, Date.now() + APPROVAL_MS)
    replay?.()
  }, () => { asking.delete(contents) })
  return false
}
