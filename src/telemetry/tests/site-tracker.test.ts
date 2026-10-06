import { describe, expect, it, vi } from 'vitest'
import { SiteTracker, TRUST_CACHE_TTL_MS, type SiteTrustAnswer } from '../site-tracker.js'

function setup (answers: Record<string, SiteTrustAnswer | null | 'throw'>) {
  const emitted: string[] = []
  let now = 1000
  const pending: Array<() => void> = []
  const classify = vi.fn(async (url: string) => {
    await new Promise<void>((resolve) => { pending.push(resolve) })
    const host = new URL(url).hostname
    const answer = answers[host]
    if (answer === 'throw') throw new Error('provider down')
    return answer ?? null
  })
  const tracker = new SiteTracker({ classify, emit: (key) => { emitted.push(key) }, now: () => now })
  const release = async (): Promise<void> => { pending.splice(0).forEach((resolve) => { resolve() }); await new Promise((resolve) => setTimeout(resolve, 0)) }
  return { tracker, emitted, classify, release, advance: (ms: number) => { now += ms }, answers }
}

describe('SiteTracker', () => {
  it('counts under internal until the answer arrives, then under the answered class', async () => {
    const { tracker, emitted, release } = setup({ 'vitalik.eth': { level: 4, judged: false } })
    tracker.show('https://vitalik.eth/')
    expect(emitted).toEqual(['internal'])
    await release()
    expect(emitted).toEqual(['internal', 'web3:vitalik.eth'])
  })

  it('asks once per origin and answers the next page of it at once', async () => {
    const { tracker, emitted, release, classify } = setup({ 'app.example.org': { level: 2, judged: false } })
    tracker.show('https://app.example.org/a')
    await release()
    tracker.show('https://app.example.org/b?x=1')
    expect(classify).toHaveBeenCalledTimes(1)
    expect(emitted).toEqual(['internal', 'web25:app.example.org'])
  })

  it('asks again once the ten minutes are up', async () => {
    const { tracker, release, classify, advance } = setup({ 'app.example.org': { level: 2, judged: false } })
    tracker.show('https://app.example.org/')
    await release()
    advance(TRUST_CACHE_TTL_MS + 1)
    tracker.show('https://app.example.org/')
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it('drops an answer for an address the person has already left', async () => {
    const { tracker, emitted, release } = setup({ 'slow.example.org': { level: 4, judged: false }, 'news.example.com': { level: 1, judged: false } })
    tracker.show('https://slow.example.org/')
    tracker.show('https://news.example.com/')
    await release()
    expect(emitted).toEqual(['internal', 'web2'])
  })

  it('counts a site with no answer, or a failed question, as Web2, and never asks for the browser own pages', async () => {
    const { tracker, emitted, release, classify } = setup({ 'down.example.org': 'throw' })
    tracker.show('orivon://settings/')
    tracker.show('about:blank')
    tracker.show('')
    expect(classify).not.toHaveBeenCalled()
    tracker.show('https://down.example.org/')
    await release()
    expect(emitted).toEqual(['internal', 'web2'])
  })

  it('names a judged CID and keeps an unjudged one as its class alone', async () => {
    const cid = 'bafybeibnroh2zbqvqgasvvnphmlzdpsvthyzyp3zlcgxqxsgk6kbtmeqmy'
    const { tracker, emitted, release } = setup({ [cid]: { level: 3, judged: false } })
    tracker.show(`ipfs://${cid}/`)
    await release()
    expect(emitted).toEqual(['internal', 'web25:'])
  })

  it('does not repeat a key it just gave', () => {
    const { tracker, emitted } = setup({})
    tracker.show('')
    tracker.show('about:blank')
    expect(emitted).toEqual(['internal'])
  })
})

describe('SiteTracker: an answer that is not there yet', () => {
  it('keeps the cache at two minutes', () => {
    expect(TRUST_CACHE_TTL_MS).toBe(2 * 60 * 1000)
  })

  it('never keeps a missing answer, so a page asked about before the loader was up is asked about again', async () => {
    const { tracker, emitted, release, classify, answers } = setup({ 'vitalik.eth': null })
    tracker.show('https://vitalik.eth/')
    await release()
    expect(emitted).toEqual(['internal', 'web2'])
    answers['vitalik.eth'] = { level: 4, judged: false }
    tracker.show('https://vitalik.eth/other')
    expect(classify).toHaveBeenCalledTimes(2)
    await release()
    expect(emitted).toEqual(['internal', 'web2', 'internal', 'web3:vitalik.eth'])
  })

  it('refresh asks again about the page in front once the answer has expired, without passing through internal, and picks up a higher level', async () => {
    const { tracker, emitted, release, advance, answers } = setup({ 'app.example.org': { level: 2, judged: false } })
    tracker.show('https://app.example.org/')
    await release()
    answers['app.example.org'] = { level: 4, judged: false }
    tracker.refresh()
    await release()
    expect(emitted).toEqual(['internal', 'web25:app.example.org'])
    advance(TRUST_CACHE_TTL_MS + 1)
    tracker.refresh()
    await release()
    expect(emitted).toEqual(['internal', 'web25:app.example.org', 'web3:app.example.org'])
  })

  it('refresh does nothing before any page was shown', () => {
    const { tracker, emitted, classify } = setup({})
    tracker.refresh()
    expect(emitted).toEqual([])
    expect(classify).not.toHaveBeenCalled()
  })
})
