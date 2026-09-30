// Keeps every live shell surface carrying the current shell stylesheet. A sheet is tied to the document it was
// inserted into, so a navigation inserts it again; a changed setting takes the old one out first.
import type { App, WebContents } from 'electron'
import type { SettingChange } from '../settings/settings-store.js'
import { isShellSurface, shellCss, SHELL_STYLE_PARTS } from './shell-style.js'
import type { SettingsReader, ShellStylePart, SurfaceEnv } from './shell-style.js'

type Surface = Pick<WebContents, 'session' | 'getURL' | 'isDestroyed' | 'insertCSS' | 'removeInsertedCSS' | 'on' | 'once'>

interface Tracked {
  /** What `insertCSS` returned for the sheet now in the document, or null. */
  key: string | null
  /** Work queued for this surface, one step after another, so two changes never interleave. */
  queue: Promise<void>
}

export function installShellStyle (
  app: Pick<App, 'on'>,
  settings: SettingsReader & { onChange: (listener: (change: SettingChange) => void) => () => void },
  env: SurfaceEnv,
  parts: readonly ShellStylePart[] = SHELL_STYLE_PARTS
): () => void {
  const tracked = new Map<Surface, Tracked>()
  const keys = new Set(parts.flatMap((part) => part.keys))

  const insert = async (surface: Surface, state: Tracked): Promise<void> => {
    const css = shellCss(settings, parts)
    if (css === '' || surface.isDestroyed()) return
    state.key = await surface.insertCSS(css)
  }

  const enqueue = (surface: Surface, state: Tracked, step: () => Promise<void>): void => {
    state.queue = state.queue.then(step).catch((error: unknown) => { console.error('[shell] the shell style could not be applied:', error) })
  }

  const loaded = (surface: Surface): void => {
    if (!isShellSurface(surface, env)) return
    let state = tracked.get(surface)
    if (state === undefined) {
      state = { key: null, queue: Promise.resolve() }
      tracked.set(surface, state)
      surface.once('destroyed', () => { tracked.delete(surface) })
    }
    const current = state
    // A new document has none of the sheets the last one had.
    enqueue(surface, current, async () => { current.key = null; await insert(surface, current) })
  }

  app.on('web-contents-created', (_event, contents) => { contents.on('dom-ready', () => { loaded(contents) }) })

  return settings.onChange(({ key }) => {
    if (!keys.has(key)) return
    for (const [surface, state] of tracked) {
      enqueue(surface, state, async () => {
        if (state.key !== null && !surface.isDestroyed()) await surface.removeInsertedCSS(state.key)
        state.key = null
        await insert(surface, state)
      })
    }
  })
}
