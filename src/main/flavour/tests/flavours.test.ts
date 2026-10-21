import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findFlavour, flavourFromFileName, flavourProblems, parseFlavours, taggedId } from '../flavours.js'

const file = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../resources/flavours.json'), 'utf8')) as unknown

describe('the allowlist file', () => {
  it('is sound', () => {
    expect(flavourProblems(file)).toEqual([])
  })

  it('names the six apps', () => {
    expect(parseFlavours(file).map((flavour) => flavour.id)).toEqual(['explore', 'webtorrent', 'asgardex', 'thelounge', 'freetube', 'element'])
  })

  it('leaves out an app whose own checks run on an emulator or a mock', () => {
    const ids = parseFlavours(file).map((flavour) => flavour.id)
    expect(ids).not.toContain('ledgerwallet')
    expect(ids).not.toContain('airgapvault')
  })

  it('reports each kind of problem, and gives no flavour for an unsound list', () => {
    const bad = { flavours: [
      { id: 'free-tube', app: 'a.orivonstack.eth', name: 'A', port: 'a' },
      { id: 'ab', app: 'https://evil.example', name: 'A', port: 'a' },
      { id: 'ab', app: 'b.orivonstack.eth', name: ' ', port: '../x' },
      { id: 'X', app: 'b.orivonstack.eth', name: 'B', port: 'b' }
    ] }
    expect(flavourProblems(bad)).toEqual([
      'free-tube: the id is not 2 to 24 lowercase letters and digits',
      'ab: the app is not <name>.orivonstack.eth',
      'ab: the id is used twice',
      'ab: the name is empty',
      'ab: the port is not a folder name',
      'X: the id is not 2 to 24 lowercase letters and digits'
    ])
    expect(parseFlavours(bad)).toEqual([])
    expect(flavourProblems(null)).toEqual(['the file has no "flavours" list'])
  })
})

describe('findFlavour', () => {
  const flavours = parseFlavours(file)
  it('finds an allowlisted id and nothing else', () => {
    expect(findFlavour(flavours, 'freetube')?.app).toBe('freetube.orivonstack.eth')
    for (const id of ['', 'FreeTube', 'unknown', '../x', 'ipfs://freetube.orivonstack.eth', 'freetube.eth']) expect(findFlavour(flavours, id), id).toBeUndefined()
  })
})

describe('flavourFromFileName', () => {
  it('reads the tag of an installer or an AppImage', () => {
    expect(flavourFromFileName('Orivon-Setup-0.0.9-x64.freetube.exe')).toBe('freetube')
    expect(flavourFromFileName('Orivon-0.0.9-x86_64.thelounge.AppImage')).toBe('thelounge')
    expect(flavourFromFileName('Orivon-Setup-1.0.0-rc.1-x64.explore.exe')).toBe('explore')
  })

  it('ignores the number a browser adds to a second download', () => {
    expect(flavourFromFileName('Orivon-Setup-0.0.9-x64.freetube (1).exe')).toBe('freetube')
    expect(flavourFromFileName('Orivon-Setup-0.0.9-x64.freetube(2).exe')).toBe('freetube')
  })

  it('reads no tag from a plain name, a name that is not a tag, or two tags', () => {
    const plain = ['Orivon-Setup-0.0.9-x64.exe', 'Orivon-0.0.9-x86_64.AppImage', 'Orivon-Setup-0.0.9-x64 (1).exe']
    const hostile = [
      'Orivon-Setup-0.0.9-x64.https___evil.exe', 'Orivon-Setup-0.0.9-x64...exe', 'Orivon-Setup-0.0.9-x64..exe',
      'Orivon-Setup-0.0.9-x64.FreeTube.exe', 'Orivon-Setup-0.0.9-x64.free-tube.exe', 'Orivon-Setup-0.0.9-x64.a.exe',
      'Orivon-Setup-0.0.9-x64.freetube.element.exe', 'Orivon-Setup-0.0.9-x64..freetube.exe', 'Orivon-Setup-0.0.9-x64..%2e.exe',
      'Orivon-Setup-0.0.9-x64.freetube.exe.exe', 'Orivon-Setup-0.0.9-x64.freetube.txt', 'x/../Orivon-Setup-0.0.9-x64.freetube.exe', ''
    ]
    for (const name of [...plain, ...hostile]) expect(flavourFromFileName(name), name).toBeNull()
  })
})

describe('taggedId', () => {
  const none = { switchValue: undefined, appImageName: null, installerName: null }

  it('is null when nothing tags the run', () => {
    expect(taggedId(none)).toBeNull()
    expect(taggedId({ ...none, installerName: 'Orivon-Setup-0.0.9-x64.exe' })).toBeNull()
  })

  it('prefers the switch, then the AppImage, then the installer', () => {
    const names = { appImageName: 'Orivon-0.0.9-x86_64.element.AppImage', installerName: 'Orivon-Setup-0.0.9-x64.freetube.exe' }
    expect(taggedId({ switchValue: 'explore', ...names })).toBe('explore')
    expect(taggedId({ switchValue: undefined, ...names })).toBe('element')
    expect(taggedId({ switchValue: undefined, appImageName: null, installerName: names.installerName })).toBe('freetube')
  })

  it('lets a switch that is given decide even when it is empty or malformed', () => {
    expect(taggedId({ switchValue: '', appImageName: 'Orivon-0.0.9-x86_64.element.AppImage', installerName: null })).toBe('')
  })
})
