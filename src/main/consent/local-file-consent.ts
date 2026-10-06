// The question put to the person before a file on this computer is let use Orivon permissions: warning style, the
// file's path, what a file is not checked for, the capabilities it declares, and a second button that answers only on a
// double press (`../shell/question/question-spec.ts`'s `doublePress`). Nothing is known about a local file but its path,
// so the words say that, and what follows from it. The capability rows are `./grant-prompt-render.ts`'s own.
import { fileURLToPath } from 'node:url'
import type { InstallConsentPrompt } from './install-consent.js'
import { describeInstallConsent } from './grant-prompt-render.js'
import { askCaller, holdCaller } from './ask-caller.js'

export const LOCAL_FILE_CONSENT_TITLE = 'Let a file on this computer use Orivon permissions?'

const MESSAGE = 'Orivon cannot check files on your computer: no Web3 Score, no pinned copy. Whoever can change this file can change what it does and use what you allow here. ' +
  'Permissions and saved data belong to this location: a different file saved here later gets them. What the page stored before starts afresh.'

/** The longest path the header shows before its middle is cut. */
const HEADER_PATH_CHARS = 70

/** `text` cut to `max` characters with `...` in the middle, so the folder it starts in and the name it ends in both stay. */
export function elideMiddle (text: string, max: number): string {
  if (text.length <= max) return text
  const keep = max - 3
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}...${text.slice(text.length - (keep - head))}`
}

/** The path a local-file key names, as the system writes it. A key that is not one is shown as it is. */
export function displayPathOf (key: string, platform: NodeJS.Platform = process.platform): string {
  try {
    return fileURLToPath(key, { windows: platform === 'win32' })
  } catch {
    return key
  }
}

/** Builds the real `InstallConsentPrompt` for a local file: the shape `requestInstallConsent`'s own takes, so the grants it leads to go through the same code. */
export function createLocalFileConsentPrompt (): InstallConsentPrompt {
  return async (key, manifest, capabilities, held = [], caller) => {
    if (caller !== undefined && !caller.stillOn(key)) return false
    const path = displayPathOf(key)
    const content = describeInstallConsent(key, manifest, capabilities, held)
    // `describeInstallConsent` closes with the address it was given; here that is the key, so the path replaces it.
    const lines = content.detail?.split('\n') ?? []
    const detail = [...lines.slice(0, -1), path].join('\n')
    const release = holdCaller(caller)
    try {
      const { response } = await askCaller(caller, {
        kind: 'consent',
        origin: elideMiddle(path, HEADER_PATH_CHARS),
        warning: true,
        title: LOCAL_FILE_CONSENT_TITLE,
        message: MESSAGE,
        detail,
        buttons: ["Don't allow", 'Double-click to allow'],
        cancelId: 0,
        doublePress: [1],
        focus: 'dialog'
      })
      return response === 1
    } finally {
      release()
    }
  }
}
