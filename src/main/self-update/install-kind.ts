// Which package this copy of Orivon came from, and so which file of a release replaces it. Pure: the facts come in.

export type InstallerKind = 'appimage' | 'deb' | 'nsis' | 'mac'

export interface InstallFacts {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly isPackaged: boolean
  /** The AppImage's own path, set inside one. */
  readonly appImage: string | undefined
  readonly execPath: string
  /** Whether the system's package manager owns `execPath`: the answer of `dpkg -S` on Linux, false elsewhere. */
  readonly debOwned: boolean
}

export type InstallKind =
  | { readonly kind: InstallerKind }
  | { readonly kind: 'manual', readonly why: 'source' | 'unsupported' }

/** What the person is told when this copy cannot replace itself. */
export const MANUAL_WORDS = {
  source: 'This copy runs from its source folder, so it cannot replace itself.',
  unsupported: 'This copy of Orivon was installed in a way it cannot update by itself.',
  noPackage: 'This release has no package for this system.'
} as const

export function installKind (facts: InstallFacts): InstallKind {
  if (!facts.isPackaged) return { kind: 'manual', why: 'source' }
  if (facts.platform === 'win32') return { kind: 'nsis' }
  if (facts.platform === 'darwin') return { kind: 'mac' }
  if (facts.platform === 'linux') {
    if (facts.appImage !== undefined && facts.appImage !== '') return { kind: 'appimage' }
    if (facts.debOwned) return { kind: 'deb' }
  }
  return { kind: 'manual', why: 'unsupported' }
}

/** The file name electron-builder gives the package of `kind`: `electron-builder.yml` names the patterns, and a test holds the two together. */
export function packageName (kind: InstallerKind, version: string, arch: string): string {
  switch (kind) {
    case 'appimage': return `Orivon-${version}-${arch === 'x64' ? 'x86_64' : arch}.AppImage`
    case 'deb': return `orivon_${version}_${arch === 'x64' ? 'amd64' : arch}.deb`
    case 'nsis': return `Orivon-Setup-${version}-${arch}.exe`
    case 'mac': return `Orivon-${version}-${arch}.dmg`
  }
}
