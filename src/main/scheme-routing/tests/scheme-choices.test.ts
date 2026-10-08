import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSchemeChoices, SchemeChoices } from '../scheme-choices.js'

const APP = 'https://torrent.example'
const dirs: string[] = []
const fileIn = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-scheme-choices-'))
  dirs.push(dir)
  return join(dir, 'scheme-handlers.json')
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('SchemeChoices', () => {
  it('asks each time until the person has chosen an app', () => {
    expect(new SchemeChoices(null).get('magnet')).toBeUndefined()
  })

  it('remembers a choice across a restart', () => {
    const path = fileIn()
    new SchemeChoices(path).set('magnet', APP)
    expect(new SchemeChoices(path).get('magnet')).toBe(APP)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, schemes: { magnet: APP } })
  })

  it('forgets a choice, and says whether there was one', () => {
    const path = fileIn()
    const choices = new SchemeChoices(path)
    choices.set('magnet', APP)
    expect(choices.forget('magnet')).toBe(true)
    expect(choices.forget('magnet')).toBe(false)
    expect(new SchemeChoices(path).get('magnet')).toBeUndefined()
  })

  it('lists the schemes an app was chosen for', () => {
    const choices = new SchemeChoices(null)
    choices.set('magnet', APP)
    choices.set('bitcoin', APP)
    choices.set('mailto', 'https://mail.example')
    expect(choices.schemesOf(APP).sort()).toEqual(['bitcoin', 'magnet'])
  })

  it('refuses a scheme the browser never routes and an origin that is not canonical', () => {
    const choices = new SchemeChoices(null)
    choices.set('https', APP)
    choices.set('orivon', APP)
    choices.set('magnet', 'https://torrent.example/path')
    choices.set('magnet', 'not an origin')
    expect(choices.schemesOf(APP)).toEqual([])
    expect(choices.get('magnet')).toBeUndefined()
  })

  it('keeps a plain-http origin out of the file', () => {
    const path = fileIn()
    const choices = new SchemeChoices(path)
    choices.set('magnet', 'http://127.0.0.1:8080')
    expect(choices.get('magnet')).toBe('http://127.0.0.1:8080')
    expect(JSON.parse(readFileSync(path, 'utf8')).schemes).toEqual({})
  })

  it('tells listeners when a choice changes', () => {
    const choices = new SchemeChoices(null)
    const heard = vi.fn()
    const stop = choices.onChange(heard)
    choices.set('magnet', APP)
    choices.set('magnet', APP)
    choices.forget('magnet')
    stop()
    choices.set('magnet', APP)
    expect(heard).toHaveBeenCalledTimes(2)
  })
})

describe('parseSchemeChoices', () => {
  it('starts empty on anything it does not recognise', () => {
    for (const raw of ['', 'not json', '[]', 'null', '{"version":2,"schemes":{"magnet":"https://a.example"}}', '{"version":1,"schemes":[]}']) {
      expect(parseSchemeChoices(raw).size, raw).toBe(0)
    }
  })

  it('keeps only entries whose scheme may be routed and whose origin is exact', () => {
    const raw = JSON.stringify({ version: 1, schemes: { magnet: APP, https: APP, orivon: APP, Bitcoin: APP, mailto: 'https://mail.example/inbox', tel: 7 } })
    expect([...parseSchemeChoices(raw)]).toEqual([['magnet', APP]])
  })

  it('survives a file that cannot be read', () => {
    const path = fileIn()
    writeFileSync(path, '{')
    expect(new SchemeChoices(path).get('magnet')).toBeUndefined()
  })
})
