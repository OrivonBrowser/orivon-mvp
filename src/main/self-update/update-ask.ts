// What the browser asks the person when a newer release is found, and how to read the answer. Pure: the wording and
// the button order live here, the window and the asking are ./install-update-notice.ts.
import type { QuestionSpec } from '../shell/question/question-spec.js'

export type UpdateChoice = 'install' | 'github' | 'later'

/** Whether this copy can replace itself. Not yet: the question then offers the release page alone, with `why` as its detail when there is one. */
export type Installable = { readonly ok: true } | { readonly ok: false, readonly why?: string }

const INSTALL = 0
const DOWNLOAD = 0

/** `version` and `current` are shown as written, so the caller passes them without a leading `v`. */
export function updateQuestion (version: string, current: string, installable: Installable): QuestionSpec {
  const common = {
    kind: 'notice',
    title: `Orivon ${version} is available`,
    message: `You have ${current}.`,
    // The question appears while the person may be typing: a key meant for the page must land on no button.
    focus: 'dialog'
  } as const
  if (installable.ok) return { ...common, guarded: [INSTALL], buttons: ['Install update', 'Download from GitHub', 'Not now'], cancelId: 2 }
  return {
    ...common,
    guarded: [DOWNLOAD],
    ...(installable.why === undefined ? {} : { detail: installable.why }),
    buttons: ['Download from GitHub', 'Not now'],
    cancelId: 1
  }
}

/** The index of the button the question answered with, as a choice; a way out is `later`. */
export function readUpdateChoice (response: number, installable: Installable): UpdateChoice {
  if (installable.ok) return response === 0 ? 'install' : response === 1 ? 'github' : 'later'
  return response === 0 ? 'github' : 'later'
}
