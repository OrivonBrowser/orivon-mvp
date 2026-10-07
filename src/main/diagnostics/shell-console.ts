// Which console messages of a renderer belong in the log: those of Orivon's own pages (the window UI, the
// overlays, `orivon://` pages), never those of a website or an app, whose messages are theirs; and what a report calls
// each kind of process that died. Pure.
import { INTERNAL_SCHEME } from '../pages/internal-pages.js'
import { SHELL_HOST, SHELL_SCHEME } from '../shell/shell-session.js'

/** The name of the shell page `url` is, or undefined when it is not one of Orivon's own. `devOrigin` is the renderer dev server's origin, when one is running. */
export function shellPageName (url: string, devOrigin: string | undefined): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol === `${INTERNAL_SCHEME}:`) return parsed.hostname === '' ? undefined : parsed.hostname
  const own = parsed.protocol === `${SHELL_SCHEME}:` ? parsed.hostname === SHELL_HOST : devOrigin !== undefined && parsed.origin === devOrigin
  if (!own) return undefined
  const [first] = parsed.pathname.split('/').filter((part) => part !== '')
  return first === undefined || first === 'index.html' ? 'chrome' : first
}

export type RendererLevel = 'info' | 'warning' | 'error' | 'debug'

/** The line for one message, or undefined when it is not a warning or an error: the shell's routine output is not worth a report's 1000 lines. */
export function rendererLine (level: RendererLevel, page: string, message: string, sourceId: string, lineNumber: number): { level: 'warn' | 'error', text: string } | undefined {
  if (level !== 'warning' && level !== 'error') return undefined
  const source = sourceId === '' ? '' : ` (${sourceId.split('/').slice(-2).join('/')}:${lineNumber})`
  return { level: level === 'error' ? 'error' : 'warn', text: `[renderer:${page}] ${message}${source}` }
}

export interface ProcessFacts {
  /** The id of the internal page this is, when it is one. */
  readonly internalPage: string | undefined
  readonly isTab: boolean
  readonly url: string
  readonly devOrigin: string | undefined
}

/** What a report calls the page process that died: `page:<id>` for an `orivon://` page, `tab`, `extension`, `app-host` (an app's hidden child host) or `shell` (the window's own UI). */
export function processName (facts: ProcessFacts): string {
  if (facts.internalPage !== undefined) return `page:${facts.internalPage}`
  if (facts.isTab) return 'tab'
  if (facts.url.startsWith('chrome-extension:')) return 'extension'
  if (facts.url.includes('/.well-known/orivon/child-host')) return 'app-host'
  return shellPageName(facts.url, facts.devOrigin) === undefined ? 'tab' : 'shell'
}

export interface ChildFacts {
  readonly type: string
  readonly serviceName: string | undefined
  readonly name: string | undefined
}

/** `GPU`, `Utility:<service>` and the like: the process type, with a utility process named by its service. */
export function childProcessName (child: ChildFacts): string {
  if (child.type !== 'Utility') return child.type
  const service = child.serviceName ?? child.name
  return service === undefined || service === '' ? 'Utility' : `Utility:${service}`
}
