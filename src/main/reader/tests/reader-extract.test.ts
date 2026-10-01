import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTRACT_MS, READER_WORLD_ID, checkReadable, extractArticle, extractScript, librarySources, readableScript } from '../reader-extract.js'

const SOURCES = { readability: 'function Readability () {}', readerable: 'function isProbablyReaderable () { return true }' }

function page (answer: () => Promise<unknown>, over: Record<string, unknown> = {}) {
  const calls: Array<{ world: number, code: string }> = []
  const wc = {
    executeJavaScriptInIsolatedWorld: (world: number, scripts: Array<{ code: string }>) => {
      calls.push({ world, code: scripts[0]?.code ?? '' })
      return answer()
    },
    getURL: () => 'https://example.com/post',
    isDestroyed: () => false,
    isCrashed: () => false,
    isLoading: () => false,
    ...over
  }
  return { wc: wc as never, calls }
}

afterEach(() => { vi.useRealTimers() })

describe('the scripts', () => {
  it('compile, with the real library inside', () => {
    const real = librarySources()
    expect(real.readability).toContain('function Readability')
    expect(real.readerable).toContain('function isProbablyReaderable')
    for (const code of [extractScript(real), readableScript(real), extractScript(SOURCES), readableScript(SOURCES)]) {
      expect(() => new Function(`return ${code}`)).not.toThrow()
    }
  })

  it('send the walker along, and run in the reader world', async () => {
    const { wc, calls } = page(async () => await Promise.resolve(null))
    await extractArticle(wc, () => SOURCES)
    expect(calls[0]?.world).toBe(READER_WORLD_ID)
    expect(calls[0]?.code).toContain('walkReaderContent')
  })
})

describe('extractArticle', () => {
  it('validates what the page answered', async () => {
    const answer = JSON.stringify({ title: 'Hi', blocks: [{ t: 'p', c: ['Hello'] }, { t: 'script' }] })
    const { wc } = page(async () => await Promise.resolve(answer))
    const article = await extractArticle(wc, () => SOURCES)
    expect(article).toMatchObject({ title: 'Hi', url: 'https://example.com/post', words: 1 })
    expect(article?.blocks).toHaveLength(1)
  })

  it('answers null for nothing, for bad JSON, for a rejection and for a page that cannot answer', async () => {
    for (const answer of [async () => await Promise.resolve(null), async () => await Promise.resolve('{'), async () => await Promise.reject(new Error('gone')), async () => await Promise.resolve(JSON.stringify({ blocks: [] }))]) {
      expect(await extractArticle(page(answer).wc, () => SOURCES)).toBeNull()
    }
    const dead = page(async () => await Promise.resolve('{}'), { isDestroyed: () => true })
    expect(await extractArticle(dead.wc, () => SOURCES)).toBeNull()
    expect(dead.calls).toHaveLength(0)
  })

  it('gives up on a page that never answers', async () => {
    vi.useFakeTimers()
    const { wc } = page(() => new Promise(() => {}))
    const pending = extractArticle(wc, () => SOURCES)
    await vi.advanceTimersByTimeAsync(EXTRACT_MS + 10)
    expect(await pending).toBeNull()
  })
})

describe('checkReadable', () => {
  it('is true only for an answer of true, and never asks a page that is loading or gone', async () => {
    expect(await checkReadable(page(async () => await Promise.resolve('true')).wc, () => SOURCES)).toBe(true)
    expect(await checkReadable(page(async () => await Promise.resolve('false')).wc, () => SOURCES)).toBe(false)
    expect(await checkReadable(page(async () => await Promise.reject(new Error('x'))).wc, () => SOURCES)).toBe(false)
    const loading = page(async () => await Promise.resolve('true'), { isLoading: () => true })
    expect(await checkReadable(loading.wc, () => SOURCES)).toBe(false)
    expect(loading.calls).toHaveLength(0)
  })
})
