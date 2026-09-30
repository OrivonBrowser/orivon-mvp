import { describe, expect, it, vi } from 'vitest'
import { AuthChallenges, MAX_PER_LOAD, WAIT_MS } from '../auth-queue.js'
import type { AuthServer, ChallengeInput, Credentials } from '../auth-queue.js'

const SERVER: AuthServer = { scheme: 'http', host: '127.0.0.1', port: 8080, isProxy: false, realm: 'Staging' }

function setup (): { queue: AuthChallenges, timers: Array<{ run: () => void, ms: number, stopped: boolean }>, owner: object } {
  const timers: Array<{ run: () => void, ms: number, stopped: boolean }> = []
  let n = 0
  const queue = new AuthChallenges({
    schedule: (run, ms) => { const timer = { run, ms, stopped: false }; timers.push(timer); return () => { timer.stopped = true } },
    newId: () => `c${String(++n)}`
  })
  return { queue, timers, owner: {} }
}

const input = (owner: object, patch: Partial<ChallengeInput> = {}): ChallengeInput =>
  ({ owner, tabId: 't1', load: 1, server: SERVER, first: true, insecure: true, mismatch: false, ...patch })

function add (queue: AuthChallenges, owner: object, patch: Partial<ChallengeInput> = {}): { id: string | undefined, answers: Array<Credentials | null>, expired: number } {
  const seen = { id: undefined as string | undefined, answers: [] as Array<Credentials | null>, expired: 0 }
  const challenge = queue.add(input(owner, patch), (answer) => { seen.answers.push(answer) }, () => { seen.expired++ })
  seen.id = challenge?.id
  return seen
}

describe('AuthChallenges', () => {
  it('answers a challenge once, with the credentials, and ignores a second answer', () => {
    const { queue, owner } = setup()
    const one = add(queue, owner)
    expect(queue.answer(one.id as string, { username: 'u', password: 'p' })).toBe(true)
    expect(queue.answer(one.id as string, null)).toBe(false)
    expect(queue.cancel(one.id as string)).toBe(false)
    expect(one.answers).toEqual([{ username: 'u', password: 'p' }])
    expect(queue.get(one.id as string)).toBeUndefined()
  })

  it('cancels with null, and a throwing callback does not escape', () => {
    const { queue, owner } = setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const challenge = queue.add(input(owner), () => { throw new Error('gone') }, () => undefined)
    expect(() => queue.cancel(challenge?.id as string)).not.toThrow()
    log.mockRestore()
  })

  it('turns away a server the person already cancelled, for the rest of that page load', () => {
    const { queue, owner } = setup()
    const first = add(queue, owner)
    queue.cancel(first.id as string)
    const again = add(queue, owner)
    expect(again.id).toBeUndefined()
    expect(again.answers).toEqual([null])
    // Another realm, another tab and another page load each ask afresh.
    expect(add(queue, owner, { server: { ...SERVER, realm: 'Other' } }).id).toBeDefined()
    expect(add(queue, owner, { tabId: 't2' }).id).toBeDefined()
    expect(add(queue, owner, { load: 2 }).id).toBeDefined()
  })

  it('stops after three sheets in one page load', () => {
    const { queue, owner } = setup()
    for (let i = 0; i < MAX_PER_LOAD; i++) expect(add(queue, owner, { server: { ...SERVER, realm: `r${String(i)}` } }).id).toBeDefined()
    const fourth = add(queue, owner, { server: { ...SERVER, realm: 'r9' } })
    expect(fourth.id).toBeUndefined()
    expect(fourth.answers).toEqual([null])
    expect(queue.pendingCount()).toBe(MAX_PER_LOAD)
  })

  it('keeps the username of a wrong answer for the sheet that asks again', () => {
    const { queue, owner } = setup()
    const first = add(queue, owner)
    expect(queue.get(first.id as string)?.username).toBe('')
    queue.answer(first.id as string, { username: 'alice', password: 'wrong' })
    const retry = queue.add(input(owner, { first: false }), () => undefined, () => undefined)
    expect(retry?.username).toBe('alice')
  })

  it('cancels a challenge that waited out of sight, and tells the caller', () => {
    const { queue, timers, owner } = setup()
    const one = add(queue, owner)
    expect(timers).toHaveLength(1)
    expect(timers[0]?.ms).toBe(WAIT_MS)
    timers[0]?.run()
    expect(one.answers).toEqual([null])
    expect(one.expired).toBe(1)
  })

  it('does not run the clock while the sheet is on screen, and restarts it when the sheet goes out of sight', () => {
    const { queue, timers, owner } = setup()
    const one = add(queue, owner)
    queue.shown(one.id as string)
    expect(timers[0]?.stopped).toBe(true)
    queue.hidden(one.id as string)
    expect(timers).toHaveLength(2)
    expect(timers[1]?.stopped).toBe(false)
    queue.answer(one.id as string, null)
    expect(timers[1]?.stopped).toBe(true)
  })

  it('cancels and forgets every challenge of a tab that closed', () => {
    const { queue, owner } = setup()
    const a = add(queue, owner)
    const b = add(queue, owner, { server: { ...SERVER, realm: 'B' } })
    const other = add(queue, owner, { tabId: 't2' })
    queue.dropTab(owner, 't1')
    expect(a.answers).toEqual([null])
    expect(b.answers).toEqual([null])
    expect(other.answers).toEqual([])
    // The page-load memory went with the tab.
    expect(add(queue, owner).id).toBeDefined()
  })

  it('holds a login to remember until the page settles, and drops it if the server asks again', () => {
    const { queue, owner } = setup()
    const first = add(queue, owner)
    queue.answer(first.id as string, { username: 'alice', password: 's3' }, { origin: 'http://127.0.0.1:8080' })
    expect(queue.takeRemember(owner, 't1')).toEqual({ origin: 'http://127.0.0.1:8080', username: 'alice', password: 's3' })
    expect(queue.takeRemember(owner, 't1')).toBeUndefined()

    const second = add(queue, owner)
    queue.answer(second.id as string, { username: 'alice', password: 'wrong' }, { origin: 'http://127.0.0.1:8080' })
    queue.add(input(owner, { first: false }), () => undefined, () => undefined)
    expect(queue.takeRemember(owner, 't1')).toBeUndefined()
  })

  it('remembers nothing for an answer without the request, or for a cancel', () => {
    const { queue, owner } = setup()
    queue.answer(add(queue, owner).id as string, { username: 'a', password: 'b' })
    expect(queue.takeRemember(owner, 't1')).toBeUndefined()
    queue.answer(add(queue, owner, { server: { ...SERVER, realm: 'x' } }).id as string, null, { origin: 'http://127.0.0.1:8080' })
    expect(queue.takeRemember(owner, 't1')).toBeUndefined()
  })

  it('tells a proxy from a site of the same address', () => {
    const { queue, owner } = setup()
    queue.cancel(add(queue, owner).id as string)
    expect(add(queue, owner, { server: { ...SERVER, isProxy: true } }).id).toBeDefined()
  })

  it('keeps two windows apart', () => {
    const { queue, owner } = setup()
    const other = {}
    queue.cancel(add(queue, owner).id as string)
    expect(add(queue, other).id).toBeDefined()
  })
})
