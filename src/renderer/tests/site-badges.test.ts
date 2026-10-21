import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChromeContext } from '../chrome/context.js'
import { createSiteBadges } from '../chrome/site-badges.js'
import type { Web3Score } from '../../main/browsing/site-trust.js'
import { FakeNode } from './fake-dom.js'

vi.mock('../web3-shield.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../web3-shield.js')>(),
  web3Shield: () => new FakeNode('svg')
}))

afterEach(() => { vi.unstubAllGlobals() })

const ANCHOR = { x: 1, y: 2, width: 30, height: 20 }
const siteTab = { url: 'https://a.example/', isNewTab: false, isInternal: false }

function score (overrides: Partial<Web3Score> = {}): Web3Score {
  return { level: 2, unscored: false, overridden: false, localDev: false, pending: false, unreachable: false, noProvider: false, ...overrides } as Web3Score
}

async function mount (answer: Web3Score) {
  const nodes: Record<string, FakeNode> = {}
  for (const id of ['#web3-score-btn', '#web3-mark', '#site-permissions-btn']) nodes[id] = new FakeNode('button')
  Object.assign(nodes['#site-permissions-btn'] as FakeNode, { toggleAttribute: () => {} })
  vi.stubGlobal('document', { querySelector: (selector: string) => nodes[selector] ?? null })
  const act = vi.fn(() => Promise.resolve(undefined))
  const press = vi.fn()
  const active: { tab: unknown } = { tab: siteTab }
  const ctx = {
    shell: { act, press, web3ScoreFor: () => Promise.resolve(answer), siteSummaryFor: () => Promise.resolve({ asked: false, warning: false, missing: false }) },
    activeTab: () => active.tab,
    anchorFor: () => ANCHOR
  } as unknown as ChromeContext
  const badges = createSiteBadges()
  badges.init(ctx)
  badges.render?.({} as never, ctx)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { mark: nodes['#web3-mark'] as FakeNode, act, press }
}

describe('the Web mark in the address bar', () => {
  it.each([
    [score({ level: 1 }), 'Web2'],
    [score({ level: 3 }), 'Web2.5'],
    [score({ level: 4 }), 'Web3'],
    [score({ level: 2, unscored: true }), 'Web?']
  ])('is a control labelled as the card it opens, whatever it reads (%#)', async (answer, text) => {
    const { mark } = await mount(answer)
    expect(mark.textContent).toBe(text)
    expect(mark.getAttribute('aria-label')).toMatch(/^Website level [1-4] \(Web.*\)(: .*)?\. What the Web3 Score levels mean$/)
    expect(mark.title).toBe(mark.getAttribute('aria-label'))
  })

  it('opens the Web3 Score card under itself with the site\'s level, and stamps the press so a second click closes it', async () => {
    const { mark, act, press } = await mount(score({ level: 3 }))
    mark.fire('pointerdown')
    expect(press).toHaveBeenCalledExactlyOnceWith('web3-score')
    mark.fire('click')
    expect(act).toHaveBeenCalledExactlyOnceWith('overlay.toggle', { name: 'web3-score', anchor: ANCHOR, payload: { level: 3, unscored: false } })
  })

  it('tells the card when the site is a Level 2 no provider has scored', async () => {
    const { mark, act } = await mount(score({ level: 2, unscored: true }))
    mark.fire('click')
    expect(act).toHaveBeenCalledExactlyOnceWith('overlay.toggle', { name: 'web3-score', anchor: ANCHOR, payload: { level: 2, unscored: true } })
  })

  it('ignores a press that is not the primary button', async () => {
    const { mark, press } = await mount(score())
    mark.fire('pointerdown', { button: 2 })
    expect(press).not.toHaveBeenCalled()
  })
})
