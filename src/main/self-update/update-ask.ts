// What the browser asks the person when a newer release is found, and how to read the answer. Pure: the wording and
// the button order live here, the window and the asking are ./install-update-notice.ts.
import type { QuestionSpec } from '../shell/question/question-spec.js'
import { LATEST_RELEASE_NAME } from './release-url.js'

export type UpdateChoice = 'install' | 'github' | 'ens' | 'later'

/** Whether this copy can replace itself. Not yet: the question then offers the two download pages alone, with `why` as its detail when there is one. */
export type Installable = { readonly ok: true } | { readonly ok: false, readonly why?: string }

const INSTALL = 0
const DOWNLOAD = 0
const FROM_GITHUB = 'Download from GitHub'
const FROM_NAME = `Download from ${LATEST_RELEASE_NAME}`

/** `version` and `current` are shown as written, so the caller passes them without a leading `v`. */
export function updateQuestion (version: string, current: string, installable: Installable): QuestionSpec {
  const common = {
    kind: 'notice',
    title: `Orivon ${version} is available`,
    message: `You have ${current}.`,
    // The question appears while the person may be typing: a key meant for the page must land on no button.
    focus: 'dialog'
  } as const
  if (installable.ok) return { ...common, guarded: [INSTALL], buttons: ['Install update', FROM_GITHUB, FROM_NAME, 'Not now'], cancelId: 3 }
  return {
    ...common,
    guarded: [DOWNLOAD],
    ...(installable.why === undefined ? {} : { detail: installable.why }),
    buttons: [FROM_GITHUB, FROM_NAME, 'Not now'],
    cancelId: 2
  }
}

/** The index of the button the question answered with, as a choice; a way out is `later`. */
export function readUpdateChoice (response: number, installable: Installable): UpdateChoice {
  const downloads: readonly UpdateChoice[] = installable.ok ? ['install', 'github', 'ens'] : ['github', 'ens']
  return downloads[response] ?? 'later'
}
