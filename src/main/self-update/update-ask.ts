// What the browser asks the person when a newer release is found, and when an install failed, and how to read the
// answer. Pure: the wording and the button order live here, the window and the asking are ../self-update/self-update.ts.
import type { QuestionSpec } from '../shell/question/question-spec.js'

export type UpdateChoice = 'install' | 'github' | 'later'

export type Installable = { readonly ok: true } | { readonly ok: false, readonly why: string }

const INSTALL = 0

/** Install is offered only when this copy can replace itself; otherwise the release page is the way. */
export function updateQuestion (version: string, current: string, installable: Installable): QuestionSpec {
  const common = {
    kind: 'notice',
    title: `Orivon ${version} is available`,
    message: `You have ${current}.`,
    // The question appears while the person may be typing: a key meant for the page must land on no button.
    focus: 'dialog',
    guarded: [INSTALL]
  } as const
  if (installable.ok) return { ...common, buttons: ['Install update', 'Download from GitHub', 'Not now'], cancelId: 2 }
  return { ...common, detail: installable.why, buttons: ['Download from GitHub', 'Not now'], cancelId: 1 }
}

export function readUpdateChoice (response: number, installable: Installable): UpdateChoice {
  if (installable.ok) return response === 0 ? 'install' : response === 1 ? 'github' : 'later'
  return response === 0 ? 'github' : 'later'
}

export function failureQuestion (reason: string): QuestionSpec {
  return {
    kind: 'notice',
    title: 'Orivon could not install the update',
    message: 'You can keep using this version, or download the new one yourself.',
    detail: reason,
    buttons: ['Download from GitHub', 'Close'],
    cancelId: 1,
    guarded: [0],
    focus: 'dialog'
  }
}
