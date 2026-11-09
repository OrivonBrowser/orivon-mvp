// Which of this computer's settings carry its proxy, picked as Chromium's `system` mode picks them, and what a read of them
// comes to whichever they were. Pure: the platform and the environment are handed in.

/** Where a computer keeps its proxy settings. `readerFor` in `run-readers.ts` says which can be read; the others are named so a report can say which one it was. */
export type SettingsSourceName = 'gnome' | 'kde' | 'windows' | 'macos' | 'environment'

/** What a read of the settings comes to, in words that hold no address, URL or exception. */
export type SystemSettings =
  /** No proxy: connections leave directly. */
  | { readonly kind: 'none' }
  /** One or more proxy servers for named schemes, in the syntax `setProxy` takes, and the hosts that skip them, each in that syntax too. */
  | { readonly kind: 'manual', readonly proxyRules: string, readonly exceptions: readonly string[] }
  /** The system names a proxy script by address; a copy of it is not made yet. */
  | { readonly kind: 'script' }
  /** The system finds its proxy by looking for one; never copied. */
  | { readonly kind: 'detect' }
  /** Settings a copy cannot carry exactly. */
  | { readonly kind: 'unsupported' }
  /** The read failed, or took too long. */
  | { readonly kind: 'unreadable' }

type Environment = Readonly<Record<string, string | undefined>>

/** The desktops Chromium reads proxy settings of its own for; any other Linux desktop reads the environment alone. */
type Desktop = 'gnome' | 'kde' | 'other'

/** Chromium's `GetDesktopEnvironment`, down to the two answers that matter here: the GNOME family (GNOME, Unity, Cinnamon, Pantheon, Deepin, UKUI, COSMIC) reads GSettings, KDE reads its own files. */
export function desktopOf (env: Environment): Desktop {
  const has = (name: string): boolean => env[name] !== undefined
  const current = (env['XDG_CURRENT_DESKTOP'] ?? '').split(':').map((part) => part.trim()).filter((part) => part !== '')
  for (const name of current) {
    if (name === 'GNOME' || name === 'Unity' || name === 'X-Cinnamon' || name === 'Pantheon' || name === 'Deepin' || name === 'UKUI' || name === 'COSMIC') return 'gnome'
    if (name === 'KDE') return 'kde'
    if (name === 'XFCE' || name === 'LXQt') return 'other'
  }
  const session = env['DESKTOP_SESSION']
  if (session !== undefined) {
    if (session === 'gnome' || session === 'mate' || session === 'deepin' || session === 'ukui') return 'gnome'
    if (session === 'kde4' || session === 'kde-plasma' || session === 'kde') return 'kde'
    if (session.includes('xfce') || session === 'xubuntu') return 'other'
  }
  if (has('GNOME_DESKTOP_SESSION_ID')) return 'gnome'
  if (has('KDE_FULL_SESSION')) return 'kde'
  return 'other'
}

/** Where the proxy of a computer running `platform` with `env` is kept, as Chromium looks for it. */
export function sourceOf (platform: string, env: Environment): SettingsSourceName {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  const desktop = desktopOf(env)
  return desktop === 'other' ? 'environment' : desktop
}
