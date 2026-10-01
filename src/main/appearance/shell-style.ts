// The one source for what changes the look of Orivon's own surfaces (the toolbar, the popups, the internal
// pages, the new-tab page). Each renderer carries its own copy of the colour tokens, so nothing on the page
// side can reach them all; main injects one stylesheet built from these parts instead.
import type { Session, WebContents } from 'electron'
import type { SettingKey } from '../settings/schema.js'
import type { SettingsStore } from '../settings/settings-store.js'
import { contain } from '../shell/contain.js'

export type SettingsReader = Pick<SettingsStore, 'get'>

export interface ShellStylePart {
  readonly name: string
  /** A change to one of these settings builds the stylesheet again. */
  readonly keys: readonly SettingKey[]
  /** The part's rules, or '' when the part is off. A rule that overrides a token a page defines on `:root` is written with `rootTokens` or `darkTokens`. */
  css: (settings: SettingsReader) => string
}

export const SHELL_STYLE_PARTS: readonly ShellStylePart[] = []

const TOKEN_NAME = /^--[a-z0-9-]{1,48}$/
const TOKEN_VALUE = /^[^{};<>\\]{1,120}$/

function declarations (tokens: Readonly<Record<string, string>>): string {
  const lines = Object.entries(tokens).map(([name, value]) => {
    if (!TOKEN_NAME.test(name) || !TOKEN_VALUE.test(value)) throw new Error(`not a token override: ${name}`)
    return `${name}:${value}`
  })
  return lines.join(';')
}

/** Tokens set on `:root` with more weight than a page's own `:root` rule, which is what a page's stylesheet would otherwise win with. */
export function rootTokens (tokens: Readonly<Record<string, string>>): string {
  return `:root:root{${declarations(tokens)}}`
}

/** As `rootTokens`, for a dark theme only. */
export function darkTokens (tokens: Readonly<Record<string, string>>): string {
  return `@media (prefers-color-scheme: dark){${rootTokens(tokens)}}`
}

/** What every shell surface is given: the parts that are on, one after another. A part that throws is left out. */
export function shellCss (settings: SettingsReader, parts: readonly ShellStylePart[] = SHELL_STYLE_PARTS): string {
  return parts.map((part) => contain(`the ${part.name} shell style`, '', () => part.css(settings))).filter((css) => css !== '').join('\n')
}

/** What tells a surface of Orivon's own from a site's tab. */
export interface SurfaceEnv {
  readonly shellSession: Session
  /** The internal pages' session is made on first use, so it is asked for each time. */
  readonly internalSession: () => Session | undefined
  readonly dashboardUrl: string
}

const withoutQuery = (url: string): string => url.replace(/[?#].*$/, '')

/**
 * The chrome, its popups and the split frame (the shell's session), the internal pages (theirs) and the
 * new-tab page (by its address, once it has loaded). Never a site's tab, never an extension's page.
 */
export function isShellSurface (contents: Pick<WebContents, 'session' | 'getURL'>, env: SurfaceEnv): boolean {
  if (contents.session === env.shellSession) return true
  const internal = env.internalSession()
  if (internal !== undefined && contents.session === internal) return true
  return withoutQuery(contents.getURL()) === withoutQuery(env.dashboardUrl)
}
