import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aumidOfHandler, isSameStoreApp, isStoreInstall, progIdOf, STORE_APPLICATION_ID, storeAumid } from '../windows-store.js'

const INSTALLED = 'C:\\Program Files\\WindowsApps\\Orivon.Browser_1.2.0.0_x64__8wekyb3d8bbwe\\app\\Orivon.exe'

describe('the package a Store install runs from', () => {
  it('names its AUMID from the folder Windows installs the package into', () => {
    expect(storeAumid(INSTALLED)).toBe('Orivon.Browser_8wekyb3d8bbwe!Orivon')
  })

  it('takes the folder name case-blind and with either slash, as Windows reports paths both ways', () => {
    expect(storeAumid(INSTALLED.toLowerCase().replace(/\\/g, '/'))).toBe('orivon.browser_8wekyb3d8bbwe!Orivon')
  })

  it('has none outside a package folder: an installer, a checkout, a packaged-looking name', () => {
    expect(storeAumid('C:\\Users\\a\\AppData\\Local\\Programs\\Orivon\\Orivon.exe')).toBeUndefined()
    expect(storeAumid('C:\\Orivon\\WindowsApps\\Orivon.exe')).toBeUndefined()
    expect(storeAumid('C:\\Program Files\\WindowsApps\\Orivon.exe')).toBeUndefined()
    expect(storeAumid('C:\\Program Files\\WindowsApps\\Orivon_1.0.0.0_x64_Orivon.exe')).toBeUndefined()
    expect(storeAumid('')).toBeUndefined()
  })

  it('keeps the application id electron-builder.yml gives the package', () => {
    const config = readFileSync(join(__dirname, '..', '..', '..', '..', 'electron-builder.yml'), 'utf8')
    expect(/^appx:\n(?:[ #].*\n)*?  applicationId: (\S+)$/m.exec(config)?.[1]).toBe(STORE_APPLICATION_ID)
  })

  it('is a Store install only when Electron says so', () => {
    expect(isStoreInstall({ windowsStore: true })).toBe(true)
    expect(isStoreInstall({ windowsStore: false })).toBe(false)
    expect(isStoreInstall({})).toBe(false)
  })
})

const REG = (name: string, value: string): string =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice\r\n    ${name}    REG_SZ    ${value}\r\n\r\n`

describe('the web-link handler a person chose, as reg.exe prints it', () => {
  it('reads the program id of the choice', () => {
    expect(progIdOf(REG('ProgId', 'AppXq0fevzme2pys62n3e0fbqa7peapykr8v'))).toBe('AppXq0fevzme2pys62n3e0fbqa7peapykr8v')
    expect(progIdOf(REG('ProgId', 'ChromeHTML'))).toBe('ChromeHTML')
  })

  it('reads none from a value that could change which key is read next', () => {
    expect(progIdOf(REG('ProgId', 'Foo\\Bar'))).toBeUndefined()
    expect(progIdOf(REG('ProgId', '..'))).toBeUndefined()
    expect(progIdOf(REG('ProgId', 'a b'))).toBeUndefined()
    expect(progIdOf('')).toBeUndefined()
    expect(progIdOf('ERROR: The system was unable to find the specified registry key or value.')).toBeUndefined()
  })

  it('reads the AUMID the handler names', () => {
    expect(aumidOfHandler(REG('AppUserModelID', 'Orivon.Browser_8wekyb3d8bbwe!Orivon'))).toBe('Orivon.Browser_8wekyb3d8bbwe!Orivon')
    expect(aumidOfHandler(REG('ApplicationName', 'x'))).toBeUndefined()
  })

  it('is this app when the handler names its AUMID, in any capitals', () => {
    expect(isSameStoreApp('Orivon.Browser_8wekyb3d8bbwe!Orivon', 'orivon.browser_8wekyb3d8bbwe!ORIVON')).toBe(true)
    expect(isSameStoreApp('MSEdge_8wekyb3d8bbwe!App', 'Orivon.Browser_8wekyb3d8bbwe!Orivon')).toBe(false)
  })

  it('is never this app when either side is missing', () => {
    expect(isSameStoreApp(undefined, 'Orivon.Browser_8wekyb3d8bbwe!Orivon')).toBe(false)
    expect(isSameStoreApp('Orivon.Browser_8wekyb3d8bbwe!Orivon', undefined)).toBe(false)
    expect(isSameStoreApp(undefined, undefined)).toBe(false)
  })
})
