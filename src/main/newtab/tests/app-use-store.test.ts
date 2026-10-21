import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppUseStore } from '../app-use-store.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-app-use-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('AppUseStore', () => {
  it('keeps the last use across a restart and forgets from a time on', () => {
    const file = join(dir, 'app-use.json')
    const first = new AppUseStore(file)
    first.note('https://a.example', null, 100)
    first.note('https://b.example', null, 300)
    const second = new AppUseStore(file)
    expect(Object.keys(second.get()).sort()).toEqual(['https://a.example', 'https://b.example'])
    second.forgetSince(200)
    expect(Object.keys(new AppUseStore(file).get())).toEqual(['https://a.example'])
  })

  it('starts empty when the file is missing or damaged', () => {
    expect(new AppUseStore(join(dir, 'none.json')).get()).toEqual({})
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    const quiet = console.warn
    console.warn = () => {}
    try {
      expect(new AppUseStore(bad).get()).toEqual({})
    } finally {
      console.warn = quiet
    }
  })

  it('writes no file for a private session', () => {
    const store = new AppUseStore(null)
    store.note('https://a.example', null, 1)
    expect(Object.keys(store.get())).toEqual(['https://a.example'])
  })
})
