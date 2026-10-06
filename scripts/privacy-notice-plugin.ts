// Gives the Settings page the privacy notice as the module `virtual:privacy-notice`, read from
// docs/privacy/notice.md, which stays the one source. A plain `?raw` import would reach a file outside the
// renderer root, which the dev server serves only as `/@fs/...`, a path the shell's internal pages refuse
// outside `src/` and `node_modules/` (src/main/pages/route.ts); a virtual module is inlined whole.
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

export const PRIVACY_NOTICE_MODULE = 'virtual:privacy-notice'
const RESOLVED = `\0${PRIVACY_NOTICE_MODULE}`
const NOTICE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/privacy/notice.md')

export function privacyNotice (): Plugin {
  return {
    name: 'orivon:privacy-notice',
    resolveId (id) {
      return id === PRIVACY_NOTICE_MODULE ? RESOLVED : null
    },
    async load (id) {
      if (id !== RESOLVED) return null
      this.addWatchFile(NOTICE_FILE)
      return `export default ${JSON.stringify(await readFile(NOTICE_FILE, 'utf8'))}`
    }
  }
}
