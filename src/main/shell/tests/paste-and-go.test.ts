import { describe, expect, it, vi } from 'vitest'
import { MAX_PASTED_LENGTH, pasteAndGo, readPastedText } from '../paste-and-go.js'

describe('readPastedText', () => {
  it('returns the clipboard text', async () => {
    expect(await readPastedText(async () => 'https://example.com/')).toBe('https://example.com/')
  })

  it('is null for an empty, blank or over-long clipboard', async () => {
    expect(await readPastedText(async () => '')).toBeNull()
    expect(await readPastedText(async () => '  \n ')).toBeNull()
    expect(await readPastedText(async () => 'x'.repeat(MAX_PASTED_LENGTH + 1))).toBeNull()
  })

  it('is null when the read does not answer in time', async () => {
    expect(await readPastedText(() => new Promise<string>(() => {}), 20)).toBeNull()
  })

  it('is null when the read fails', async () => {
    expect(await readPastedText(() => Promise.reject(new Error('no clipboard')))).toBeNull()
  })
})

describe('pasteAndGo', () => {
  it('submits the text it read', async () => {
    const submit = vi.fn()
    await pasteAndGo(async () => 'example.com', submit)
    expect(submit).toHaveBeenCalledWith('example.com')
  })

  it('submits nothing when the clipboard stalls', async () => {
    const submit = vi.fn()
    await pasteAndGo(() => new Promise<string>(() => {}), submit, 20)
    expect(submit).not.toHaveBeenCalled()
  })
})
