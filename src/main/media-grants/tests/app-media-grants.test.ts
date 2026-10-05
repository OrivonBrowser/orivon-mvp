import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { AppMediaKind } from '../../display-capture/types.js'
import { createAppMediaGrants } from '../app-media-grants.js'

const ORIGIN = 'https://app.example'

function fakeTab (): { tab: WebContents, navigate: () => void, listenerCount: () => number } {
  const listeners: Array<() => void> = []
  const tab = { on: (_event: string, listener: () => void) => { listeners.push(listener) } } as unknown as WebContents
  return { tab, navigate: () => { for (const listener of [...listeners]) listener() }, listenerCount: () => listeners.length }
}

function setup (held: AppMediaKind[] = [], answer = true) {
  const ledger = new Set<AppMediaKind>(held)
  const ask = vi.fn(async (_tab: WebContents, _origin: string, kind: AppMediaKind) => {
    if (answer) ledger.add(kind)
    return answer
  })
  const grants = createAppMediaGrants({ held: (_origin, kind) => ledger.has(kind), ask })
  return { grants, ask, ledger }
}

describe('held', () => {
  it('reads the ledger and never asks', () => {
    const { grants, ask } = setup(['media.camera'])
    expect(grants.held(ORIGIN, 'media.camera')).toBe(true)
    expect(grants.held(ORIGIN, 'media.microphone')).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })
})

describe('request', () => {
  it('is true without asking for a kind that is held', async () => {
    const { grants, ask } = setup(['media.screen'])
    expect(await grants.request(fakeTab().tab, ORIGIN, 'media.screen')).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks for a kind that is not held, and is true once the person allows it', async () => {
    const { grants, ask } = setup([], true)
    const { tab } = fakeTab()
    expect(await grants.request(tab, ORIGIN, 'media.camera')).toBe(true)
    expect(ask).toHaveBeenCalledWith(tab, ORIGIN, 'media.camera')
    expect(await grants.request(tab, ORIGIN, 'media.camera')).toBe(true)
    expect(ask).toHaveBeenCalledOnce()
  })

  it('is false when the question is refused, and does not ask again on that page', async () => {
    const { grants, ask } = setup([], false)
    const { tab } = fakeTab()
    expect(await grants.request(tab, ORIGIN, 'media.microphone')).toBe(false)
    expect(await grants.request(tab, ORIGIN, 'media.microphone')).toBe(false)
    expect(ask).toHaveBeenCalledOnce()
  })

  it('asks again once the page loads again', async () => {
    const { grants, ask } = setup([], false)
    const { tab, navigate } = fakeTab()
    await grants.request(tab, ORIGIN, 'media.camera')
    navigate()
    await grants.request(tab, ORIGIN, 'media.camera')
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('keeps a refusal per kind and per tab', async () => {
    const { grants, ask } = setup([], false)
    const first = fakeTab().tab
    await grants.request(first, ORIGIN, 'media.camera')
    await grants.request(first, ORIGIN, 'media.microphone')
    await grants.request(fakeTab().tab, ORIGIN, 'media.camera')
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('answers true for a kind that became held after an earlier refusal on the same page', async () => {
    const { grants, ledger } = setup([], false)
    const { tab } = fakeTab()
    await grants.request(tab, ORIGIN, 'media.camera')
    ledger.add('media.camera')
    expect(await grants.request(tab, ORIGIN, 'media.camera')).toBe(true)
  })

  it('forgets a refusal of another origin when the same tab shows a different app', async () => {
    const { grants, ask } = setup([], false)
    const { tab } = fakeTab()
    await grants.request(tab, ORIGIN, 'media.camera')
    await grants.request(tab, 'https://other.example', 'media.camera')
    await grants.request(tab, ORIGIN, 'media.camera')
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('listens for the tab\'s navigation once, however many times the page is refused and loads again', async () => {
    const { grants } = setup([], false)
    const { tab, navigate, listenerCount } = fakeTab()
    for (let round = 0; round < 5; round++) {
      await grants.request(tab, ORIGIN, 'media.camera')
      navigate()
    }
    expect(listenerCount()).toBe(1)
  })
})
