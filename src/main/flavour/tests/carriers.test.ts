import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { carriersOf, INSTALLER_NAME_FILE, readInstallerName } from '../carriers.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-carriers-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const exe = (): string => join(dir, 'Orivon.exe')

describe('readInstallerName', () => {
  it('reads the first line the installer wrote, however it ends', () => {
    writeFileSync(join(dir, INSTALLER_NAME_FILE), 'Orivon-Setup-0.0.9-x64.freetube.exe\r\nanything after\n')
    expect(readInstallerName(exe())).toBe('Orivon-Setup-0.0.9-x64.freetube.exe')
  })

  it('is null when the file is missing or empty, and reads no more than a name', () => {
    expect(readInstallerName(exe())).toBeNull()
    writeFileSync(join(dir, INSTALLER_NAME_FILE), '\n')
    expect(readInstallerName(exe())).toBeNull()
    writeFileSync(join(dir, INSTALLER_NAME_FILE), 'a'.repeat(5000))
    expect(readInstallerName(exe())?.length).toBe(512)
  })
})

describe('carriersOf', () => {
  it('collects the switch, the AppImage name and the installer name', () => {
    writeFileSync(join(dir, INSTALLER_NAME_FILE), 'Orivon-Setup-0.0.9-x64.freetube.exe')
    expect(carriersOf(['orivon', '--orivon-flavour=explore'], { APPIMAGE: '/home/a/Downloads/Orivon-0.0.9-x86_64.element.AppImage' }, exe())).toEqual({
      switchValue: 'explore',
      appImageName: 'Orivon-0.0.9-x86_64.element.AppImage',
      installerName: 'Orivon-Setup-0.0.9-x64.freetube.exe'
    })
    expect(carriersOf(['orivon'], {}, exe())).toMatchObject({ switchValue: undefined, appImageName: null })
  })

  it('does not read a switch after the first --, which is a link or a file', () => {
    expect(carriersOf(['orivon', '--', '--orivon-flavour=explore'], {}, exe()).switchValue).toBeUndefined()
  })
})
