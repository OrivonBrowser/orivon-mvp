import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { everywhereBeforeReady, readSettingBeforeReady, settingsFileProblem, settingsFromFile } from '../settings-file.js'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-settings-file-'))
  file = join(dir, 'settings.json')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('settingsFromFile', () => {
  it('keeps what differs from the default, drops what the schema refuses and counts it', () => {
    const { overrides, dropped } = settingsFromFile({ version: 1, values: { 'privacy.globalPrivacyControl': false, 'privacy.doNotTrack': false, 'appearance.theme': 'neon', 'nope': 1 } })
    expect([...overrides]).toEqual([['privacy.globalPrivacyControl', false]])
    expect(dropped).toBe(2)
  })

  it('holds nothing for text that is not a settings file of this version', () => {
    for (const parsed of [null, 'x', [], { version: 2, values: {} }, { version: 1 }, { version: 1, values: 3 }]) {
      expect(settingsFromFile(parsed)).toEqual({ overrides: new Map(), dropped: 0 })
    }
  })
})

describe('readSettingBeforeReady', () => {
  it('reads a saved value', async () => {
    await writeFile(file, JSON.stringify({ version: 1, values: { 'privacy.globalPrivacyControl': false } }))
    expect(readSettingBeforeReady(file, 'privacy.globalPrivacyControl')).toBe(false)
  })

  it('answers the default for a missing file, a corrupt one and a value that is not there', async () => {
    expect(readSettingBeforeReady(join(dir, 'none.json'), 'privacy.globalPrivacyControl')).toBe(true)
    await writeFile(file, '{ not json')
    expect(readSettingBeforeReady(file, 'privacy.globalPrivacyControl')).toBe(true)
    await writeFile(file, JSON.stringify({ version: 1, values: { 'appearance.theme': 'dark' } }))
    expect(readSettingBeforeReady(file, 'privacy.globalPrivacyControl')).toBe(true)
  })

  it('answers the default for a value the schema refuses', async () => {
    await writeFile(file, JSON.stringify({ version: 1, values: { 'privacy.globalPrivacyControl': 'off' } }))
    expect(readSettingBeforeReady(file, 'privacy.globalPrivacyControl')).toBe(true)
  })
})

describe('everywhereBeforeReady', () => {
  it('is off for a missing file and the saved value for a good one', async () => {
    expect(everywhereBeforeReady(join(dir, 'none.json'))).toBe(false)
    await writeFile(file, JSON.stringify({ version: 2, values: {} }))
    expect(everywhereBeforeReady(file)).toBe(false)
    await writeFile(file, JSON.stringify({ version: 2, values: { 'network.tunnel.everywhere': true } }))
    expect(everywhereBeforeReady(file)).toBe(true)
  })

  it('is on for a file that is there and cannot be used: broken text, a version this build does not read, or not a settings file', async () => {
    for (const text of ['{ not json', JSON.stringify({ version: 9, values: {} }), JSON.stringify([]), JSON.stringify({ version: 2 })]) {
      await writeFile(file, text)
      expect(settingsFileProblem(file), text).toBe('unreadable')
      expect(everywhereBeforeReady(file), text).toBe(true)
    }
  })
})
