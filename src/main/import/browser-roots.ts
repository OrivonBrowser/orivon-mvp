// Where each supported browser keeps its profiles on each operating system, including the confined
// installs (snap, flatpak). Pure: the caller says which system, whose home and what the environment holds.
import { posix, win32 } from 'node:path'
import type { BrowserRoot } from './import-types.js'

export type ImportEnv = Readonly<Record<string, string | undefined>>

const FLATPAK = {
  chrome: 'com.google.Chrome',
  chromium: 'org.chromium.Chromium',
  edge: 'com.microsoft.Edge',
  brave: 'com.brave.Browser',
  firefox: 'org.mozilla.firefox'
} as const

function linuxRoots (home: string, env: ImportEnv): BrowserRoot[] {
  const config = env['XDG_CONFIG_HOME'] !== undefined && env['XDG_CONFIG_HOME'] !== '' ? env['XDG_CONFIG_HOME'] : posix.join(home, '.config')
  const app = (id: string, ...rest: string[]): string => posix.join(home, '.var', 'app', id, ...rest)
  return [
    { browser: 'chrome', family: 'chromium', root: posix.join(config, 'google-chrome') },
    { browser: 'chrome', family: 'chromium', root: app(FLATPAK.chrome, 'config', 'google-chrome') },
    { browser: 'chromium', family: 'chromium', root: posix.join(config, 'chromium') },
    { browser: 'chromium', family: 'chromium', root: posix.join(home, 'snap', 'chromium', 'common', 'chromium') },
    { browser: 'chromium', family: 'chromium', root: app(FLATPAK.chromium, 'config', 'chromium') },
    { browser: 'edge', family: 'chromium', root: posix.join(config, 'microsoft-edge') },
    { browser: 'edge', family: 'chromium', root: app(FLATPAK.edge, 'config', 'microsoft-edge') },
    { browser: 'brave', family: 'chromium', root: posix.join(config, 'BraveSoftware', 'Brave-Browser') },
    { browser: 'brave', family: 'chromium', root: app(FLATPAK.brave, 'config', 'BraveSoftware', 'Brave-Browser') },
    { browser: 'firefox', family: 'firefox', root: posix.join(home, '.mozilla', 'firefox') },
    { browser: 'firefox', family: 'firefox', root: posix.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox') },
    { browser: 'firefox', family: 'firefox', root: app(FLATPAK.firefox, '.mozilla', 'firefox') }
  ]
}

function macRoots (home: string): BrowserRoot[] {
  const support = posix.join(home, 'Library', 'Application Support')
  return [
    { browser: 'chrome', family: 'chromium', root: posix.join(support, 'Google', 'Chrome') },
    { browser: 'chromium', family: 'chromium', root: posix.join(support, 'Chromium') },
    { browser: 'edge', family: 'chromium', root: posix.join(support, 'Microsoft Edge') },
    { browser: 'brave', family: 'chromium', root: posix.join(support, 'BraveSoftware', 'Brave-Browser') },
    { browser: 'firefox', family: 'firefox', root: posix.join(support, 'Firefox') }
  ]
}

function windowsRoots (home: string, env: ImportEnv): BrowserRoot[] {
  const local = env['LOCALAPPDATA'] !== undefined && env['LOCALAPPDATA'] !== '' ? env['LOCALAPPDATA'] : win32.join(home, 'AppData', 'Local')
  const roaming = env['APPDATA'] !== undefined && env['APPDATA'] !== '' ? env['APPDATA'] : win32.join(home, 'AppData', 'Roaming')
  return [
    { browser: 'chrome', family: 'chromium', root: win32.join(local, 'Google', 'Chrome', 'User Data') },
    { browser: 'chromium', family: 'chromium', root: win32.join(local, 'Chromium', 'User Data') },
    { browser: 'edge', family: 'chromium', root: win32.join(local, 'Microsoft', 'Edge', 'User Data') },
    { browser: 'brave', family: 'chromium', root: win32.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    { browser: 'firefox', family: 'firefox', root: win32.join(roaming, 'Mozilla', 'Firefox') }
  ]
}

/** Every place a supported browser may keep its profiles, most likely first. Whether a place exists is for the caller to find out. */
export function candidateRoots (platform: NodeJS.Platform, home: string, env: ImportEnv): BrowserRoot[] {
  if (platform === 'darwin') return macRoots(home)
  if (platform === 'win32') return windowsRoots(home, env)
  return linuxRoots(home, env)
}
