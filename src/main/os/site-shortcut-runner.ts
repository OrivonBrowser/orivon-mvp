// Writing a site's shortcut where the desktop looks for one. The places come from the host, so a test points them at a
// temporary directory and never at the person's real applications folder.
import { isAbsolute, join } from 'node:path'
import { desktopEntry, entryFileName, linkArguments, linkFileName } from './site-shortcut.js'

export interface ShortcutHost {
  readonly platform: NodeJS.Platform
  readonly isPackaged: boolean
  /** The running app's own path: part of the command line of a run from source. */
  readonly appPath: string
  readonly execPath: string
  /** The environment now, read at each call: `XDG_DATA_HOME` and `APPIMAGE`. */
  env: () => Readonly<Record<string, string | undefined>>
  home: () => string
  desktop: () => string
  makeDirectory: (path: string) => Promise<void>
  writeFile: (path: string, text: string, mode: number) => Promise<void>
  writeLink: (path: string, options: { target: string, args: string, description: string }) => boolean
  /** Whether something is already at `path`: a shortcut is never written over a file the person already has. */
  exists: (path: string) => boolean
}

export interface ShortcutRequest {
  readonly name: string
  readonly address: string
  /** Set when the site is to open in the profile it was made in; absent opens it in the default one. */
  readonly profileId?: string
}

export type ShortcutResult =
  | { readonly ok: true, readonly where: 'applications' | 'desktop' }
  | { readonly ok: false, readonly reason: 'unsupported' | 'failed' }

/** What starts Orivon: an AppImage's own file, the installed program, or the Electron binary with the app beside it. */
function launcher (host: ShortcutHost): { program: string, leading: string[] } {
  const appImage = host.env()['APPIMAGE'] ?? ''
  if (appImage !== '') return { program: appImage, leading: [] }
  return host.isPackaged ? { program: host.execPath, leading: [] } : { program: host.execPath, leading: [host.appPath] }
}

/** `$XDG_DATA_HOME` when it is an absolute path (the specification says to ignore any other), else `~/.local/share`. */
export function xdgDataHome (env: Readonly<Record<string, string | undefined>>, home: string): string {
  const set = env['XDG_DATA_HOME'] ?? ''
  return isAbsolute(set) ? set : join(home, '.local', 'share')
}

const dataHome = (host: ShortcutHost): string => xdgDataHome(host.env(), host.home())

/** The first path on the desktop that nothing occupies: `Name.lnk`, then `Name (2).lnk` and so on. */
function freeLinkPath (host: ShortcutHost, name: string): string | undefined {
  const file = linkFileName(name)
  const stem = file.slice(0, -'.lnk'.length)
  for (let copy = 1; copy <= MAX_COPIES; copy += 1) {
    const path = join(host.desktop(), copy === 1 ? file : `${stem} (${String(copy)}).lnk`)
    if (!host.exists(path)) return path
  }
  return undefined
}

const MAX_COPIES = 99

export async function createShortcut (host: ShortcutHost, request: ShortcutRequest): Promise<ShortcutResult> {
  const { program, leading } = launcher(host)
  const profile = request.profileId === undefined ? {} : { profileId: request.profileId }
  try {
    if (host.platform === 'linux') {
      const directory = join(dataHome(host), 'applications')
      await host.makeDirectory(directory)
      await host.writeFile(join(directory, entryFileName(request.address, request.profileId)), desktopEntry({ name: request.name, address: request.address, program, leading, ...profile }), 0o644)
      return { ok: true, where: 'applications' }
    }
    if (host.platform === 'win32') {
      const path = freeLinkPath(host, request.name)
      if (path === undefined) return { ok: false, reason: 'failed' }
      const written = host.writeLink(path, {
        target: program,
        args: linkArguments({ address: request.address, leading, ...profile }),
        description: request.name
      })
      return written ? { ok: true, where: 'desktop' } : { ok: false, reason: 'failed' }
    }
    return { ok: false, reason: 'unsupported' }
  } catch (error) {
    console.error('[os] could not create the shortcut', error)
    return { ok: false, reason: 'failed' }
  }
}
