import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIRST_PROMPT_LINE, FirstPromptNote, installFirstPromptNote, takeFirstPromptNote, withFirstPromptLine } from '../first-prompt-note.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-first-prompt-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('FirstPromptNote', () => {
  it('is true once and then never again', () => {
    const note = new FirstPromptNote(null)
    expect([note.take(), note.take(), note.take()]).toEqual([true, false, false])
  })

  it('stays taken across a restart', () => {
    const file = join(dir, 'consent-notes.json')
    expect(new FirstPromptNote(file).take()).toBe(true)
    expect(new FirstPromptNote(file).take()).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, firstPromptShown: true })
  })

  it('starts from none when the file is missing or damaged, and still answers true only once', () => {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    const note = new FirstPromptNote(bad)
    expect([note.take(), note.take()]).toEqual([true, false])
    expect(new FirstPromptNote(join(dir, 'none.json')).take()).toBe(true)
  })

  it('keeps nothing on disk for a private session', () => {
    const note = new FirstPromptNote(null)
    note.take()
    expect(new FirstPromptNote(null).take()).toBe(true)
  })
})

describe('takeFirstPromptNote', () => {
  it('answers false until a note is installed, and the first installed one wins', () => {
    expect(takeFirstPromptNote()).toBe(false)
    installFirstPromptNote(new FirstPromptNote(null))
    installFirstPromptNote(new FirstPromptNote(join(dir, 'other.json')))
    expect([takeFirstPromptNote(), takeFirstPromptNote()]).toEqual([true, false])
  })
})

describe('withFirstPromptLine', () => {
  it('puts the line last, after the claim and before the address the panel drops', () => {
    const detail = withFirstPromptLine('Claims to be "App".\nhttps://app.example', 'https://app.example')
    expect(detail).toBe(`Claims to be "App".\n${FIRST_PROMPT_LINE}\nhttps://app.example`)
  })

  it('appends the line when the detail does not end with the address', () => {
    expect(withFirstPromptLine('Claims to be "App".', 'https://app.example')).toBe(`Claims to be "App".\n${FIRST_PROMPT_LINE}`)
  })

  it('says it in the words the wording asks for', () => {
    expect(FIRST_PROMPT_LINE).toBe('This is a desktop app. It needs more than a web page may have, so it asks you once.')
  })
})
