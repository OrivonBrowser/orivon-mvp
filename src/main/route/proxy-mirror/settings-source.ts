// Which of this computer's settings carry its proxy, picked as Chromium's `system` mode picks them, and what a read of them
// comes to whichever they were. Pure: the platform and the environment are handed in.

/** Where a computer keeps its proxy settings. A source with no reader is named all the same, so a report can say which one it was. */
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

/** The KDE generations Chromium tells apart, because each keeps `kioslaverc` somewhere else. */
export type KdeVersion = 3 | 4 | 5 | 6

type Detected = 'gnome' | 'other' | KdeVersion

/** Chromium's `GetDesktopEnvironment`: the GNOME family (GNOME, Unity, Cinnamon, Pantheon, Deepin, UKUI, COSMIC) reads GSettings, KDE its own files. Only `XDG_CURRENT_DESKTOP` tells KDE 5 and 6 from KDE 4, by `KDE_SESSION_VERSION`; the older variables name KDE 3 or 4. */
function detect (env: Environment): Detected {
  const has = (name: string): boolean => env[name] !== undefined
  const current = (env['XDG_CURRENT_DESKTOP'] ?? '').split(':').map((part) => part.trim()).filter((part) => part !== '')
  for (const name of current) {
    if (name === 'GNOME' || name === 'Unity' || name === 'X-Cinnamon' || name === 'Pantheon' || name === 'Deepin' || name === 'UKUI' || name === 'COSMIC') return 'gnome'
    if (name === 'KDE') return env['KDE_SESSION_VERSION'] === '5' ? 5 : env['KDE_SESSION_VERSION'] === '6' ? 6 : 4
    if (name === 'XFCE' || name === 'LXQt') return 'other'
  }
  const session = env['DESKTOP_SESSION']
  if (session !== undefined) {
    if (session === 'gnome' || session === 'mate' || session === 'deepin' || session === 'ukui') return 'gnome'
    if (session === 'kde4' || session === 'kde-plasma') return 4
    if (session === 'kde') return has('KDE_SESSION_VERSION') ? 4 : 3
    if (session.includes('xfce') || session === 'xubuntu') return 'other'
  }
  if (has('GNOME_DESKTOP_SESSION_ID')) return 'gnome'
  if (has('KDE_FULL_SESSION')) return has('KDE_SESSION_VERSION') ? 4 : 3
  return 'other'
}

export function desktopOf (env: Environment): Desktop {
  const found = detect(env)
  return typeof found === 'number' ? 'kde' : found
}

/** Which KDE generation Chromium takes this environment for, or undefined when the desktop is not KDE. */
export function kdeVersionOf (env: Environment): KdeVersion | undefined {
  const found = detect(env)
  return typeof found === 'number' ? found : undefined
}

/** Where the proxy of a computer running `platform` with `env` is kept, as Chromium looks for it. */
export function sourceOf (platform: string, env: Environment): SettingsSourceName {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  const desktop = desktopOf(env)
  return desktop === 'other' ? 'environment' : desktop
}
