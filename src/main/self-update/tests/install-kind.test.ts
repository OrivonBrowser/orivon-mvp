import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installKind, packageName } from '../install-kind.js'
import type { InstallFacts } from '../install-kind.js'

const facts = (patch: Partial<InstallFacts> = {}): InstallFacts =>
  ({ platform: 'linux', arch: 'x64', isPackaged: true, appImage: undefined, execPath: '/opt/Orivon/orivon', debOwned: false, ...patch })

describe('installKind', () => {
  it('knows an AppImage by the path its runtime sets', () => {
    expect(installKind(facts({ appImage: '/home/p/Orivon.AppImage' }))).toEqual({ kind: 'appimage' })
  })

  it('knows a deb by the package manager owning the executable', () => {
    expect(installKind(facts({ debOwned: true }))).toEqual({ kind: 'deb' })
  })

  it('prefers the AppImage when both facts are there: the file that runs is the one to replace', () => {
    expect(installKind(facts({ appImage: '/x.AppImage', debOwned: true }))).toEqual({ kind: 'appimage' })
  })

  it('knows the installer on Windows and the disk image on macOS', () => {
    expect(installKind(facts({ platform: 'win32' }))).toEqual({ kind: 'nsis' })
    expect(installKind(facts({ platform: 'darwin' }))).toEqual({ kind: 'mac' })
  })

  it('leaves a run from source, and a Linux copy nothing owns, to the release page', () => {
    expect(installKind(facts({ isPackaged: false, platform: 'win32' }))).toEqual({ kind: 'manual', why: 'source' })
    expect(installKind(facts({ isPackaged: false, appImage: '/x.AppImage' }))).toEqual({ kind: 'manual', why: 'source' })
    expect(installKind(facts())).toEqual({ kind: 'manual', why: 'unsupported' })
    expect(installKind(facts({ appImage: '' }))).toEqual({ kind: 'manual', why: 'unsupported' })
    expect(installKind(facts({ platform: 'freebsd' }))).toEqual({ kind: 'manual', why: 'unsupported' })
  })
})

describe('packageName', () => {
  it('names each package the way electron-builder does', () => {
    expect(packageName('appimage', '1.2.0', 'x64')).toBe('Orivon-1.2.0-x86_64.AppImage')
    expect(packageName('deb', '1.2.0', 'x64')).toBe('orivon_1.2.0_amd64.deb')
    expect(packageName('nsis', '1.2.0', 'x64')).toBe('Orivon-Setup-1.2.0-x64.exe')
    expect(packageName('mac', '1.2.0', 'arm64')).toBe('Orivon-1.2.0-arm64.dmg')
    expect(packageName('mac', '1.2.0', 'x64')).toBe('Orivon-1.2.0-x64.dmg')
  })
})

/** The names above come from electron-builder.yml; this holds the two together. */
describe('packageName against electron-builder.yml', () => {
  const root = join(import.meta.dirname, '..', '..', '..', '..')
  const config = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  /** The `artifactName` of each top-level section that sets one, by section. */
  const named: Record<string, string> = {}
  let section = ''
  for (const line of config.split('\n')) {
    const top = /^([A-Za-z]+):/.exec(line)
    if (top !== null) section = top[1] ?? ''
    const name = /^ {2}artifactName: (.+)$/.exec(line)
    if (name !== null) named[section] = name[1] ?? ''
  }
  const expand = (pattern: string, arch: string, ext: string): string =>
    pattern.replace('${productName}', 'Orivon').replace('${version}', '1.2.0').replace('${arch}', arch).replace('${ext}', ext)

  it('sets an artifactName for the AppImage, the installer and the disk image, and for no other target', () => {
    expect(Object.keys(named).sort()).toEqual(['appImage', 'dmg', 'nsis'])
    expect(config).not.toMatch(/^artifactName:/m)
  })

  it('still produces the names packageName gives', () => {
    // electron-builder writes an x64 AppImage's arch as x86_64.
    expect(expand(named['appImage'] ?? '', 'x86_64', 'AppImage')).toBe(packageName('appimage', '1.2.0', 'x64'))
    expect(expand(named['nsis'] ?? '', 'x64', 'exe')).toBe(packageName('nsis', '1.2.0', 'x64'))
    expect(expand(named['dmg'] ?? '', 'arm64', 'dmg')).toBe(packageName('mac', '1.2.0', 'arm64'))
    expect(expand(named['dmg'] ?? '', 'x64', 'dmg')).toBe(packageName('mac', '1.2.0', 'x64'))
  })

  it('names the deb after the package name, which is orivon', () => {
    const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
    expect(`${name}_1.2.0_amd64.deb`).toBe(packageName('deb', '1.2.0', 'x64'))
  })
})
