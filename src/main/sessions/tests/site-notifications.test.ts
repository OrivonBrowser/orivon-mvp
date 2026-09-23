import { describe, expect, it, vi } from 'vitest'
import type { NotificationDecision } from '../notification-decisions.js'
import { createSiteNotifications, type NotificationAnswer } from '../site-notifications.js'
import { tabPromptState } from '../tab-prompts.js'
import { fakeTab } from './fake-tab.js'

const WINDOW = { id: 'window' }
const SITE = 'https://chat.example'
const PAGE = `${SITE}/room/1`

function memoryDecisions (initial: Record<string, NotificationDecision> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get: (origin: string) => map.get(origin),
    set: vi.fn((origin: string, decision: NotificationDecision) => { map.set(origin, decision) })
  }
}

function setup (answer: NotificationAnswer = 'allow', initial: Record<string, NotificationDecision> = {}) {
  const decisions = memoryDecisions(initial)
  const ask = vi.fn(async (_window: typeof WINDOW, _origin: string): Promise<NotificationAnswer> => answer)
  const windowShowing = vi.fn((): typeof WINDOW | undefined => WINDOW)
  return { notifications: createSiteNotifications({ decisions, ask, windowShowing }), decisions, ask, windowShowing }
}

describe('site notifications: the request (Notification.requestPermission)', () => {
  it('asks the person in the window showing the tab, naming the site, and remembers an allow', async () => {
    const { notifications, decisions, ask } = setup('allow')
    expect(await notifications.request(fakeTab(PAGE), { requestingUrl: PAGE, isMainFrame: true })).toBe(true)
    expect(ask).toHaveBeenCalledWith(WINDOW, SITE)
    expect(decisions.set).toHaveBeenCalledWith(SITE, 'allow')
  })

  it('remembers a block, and refuses', async () => {
    const { notifications, decisions } = setup('block')
    expect(await notifications.request(fakeTab(PAGE), { requestingUrl: PAGE, isMainFrame: true })).toBe(false)
    expect(decisions.set).toHaveBeenCalledWith(SITE, 'block')
  })

  it('answers from the remembered decision without asking again', async () => {
    const { notifications, ask } = setup('allow', { [SITE]: 'block', 'https://mail.example': 'allow' })
    expect(await notifications.request(fakeTab(PAGE), { requestingUrl: PAGE, isMainFrame: true })).toBe(false)
    expect(await notifications.request(fakeTab(), { requestingUrl: 'https://mail.example/inbox', isMainFrame: true })).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  // Dismissing is not a decision: nothing is remembered, so the site may
  // ask again -- but not on the same page load, or a page could re-ask
  // in a loop until the person gave in.
  it('treats a dismissal as no decision, and does not ask again until the page loads again', async () => {
    const { notifications, decisions, ask } = setup('dismiss')
    const tab = fakeTab(PAGE)
    const request = async (): Promise<boolean> => await notifications.request(tab, { requestingUrl: PAGE, isMainFrame: true })

    expect(await request()).toBe(false)
    expect(await request()).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(decisions.set).not.toHaveBeenCalled()

    tab.navigate()
    await request()
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('asks one question at a time per tab', async () => {
    let answer: (a: NotificationAnswer) => void = () => {}
    const { notifications, ask } = setup()
    ask.mockImplementation(async () => await new Promise<NotificationAnswer>((resolve) => { answer = resolve }))
    const tab = fakeTab(PAGE)

    const first = notifications.request(tab, { requestingUrl: PAGE, isMainFrame: true })
    expect(await notifications.request(tab, { requestingUrl: PAGE, isMainFrame: true })).toBe(false)
    answer('allow')
    expect(await first).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('does not ask for a tab that is not the one on screen, and remembers nothing', async () => {
    const { notifications, decisions, ask, windowShowing } = setup()
    windowShowing.mockReturnValue(undefined)
    expect(await notifications.request(fakeTab(PAGE), { requestingUrl: PAGE, isMainFrame: true })).toBe(false)
    expect(ask).not.toHaveBeenCalled()
    expect(decisions.set).not.toHaveBeenCalled()
  })

  it('does not ask for a page with no origin to name', async () => {
    const { notifications, ask } = setup()
    for (const requestingUrl of ['file:///home/person/page.html', 'data:text/html,x', undefined]) {
      expect(await notifications.request(fakeTab(), { requestingUrl, isMainFrame: true })).toBe(false)
    }
    expect(ask).not.toHaveBeenCalled()
  })

  // The question names the page's own site. A frame inside it belongs to
  // someone else, and a person answering for the page they see would be
  // answering for a site they were never shown.
  it('never asks from a frame; a same-site frame gets the page\'s own remembered answer, any other frame is refused', async () => {
    const { notifications, ask } = setup('allow', { [SITE]: 'allow', 'https://ads.example': 'allow' })
    const tab = fakeTab(PAGE)
    expect(await notifications.request(tab, { requestingUrl: `${SITE}/frame`, isMainFrame: false })).toBe(true)
    expect(await notifications.request(tab, { requestingUrl: 'https://ads.example/frame', isMainFrame: false })).toBe(false)
    expect(await notifications.request(tab, { requestingUrl: 'https://new.example/frame', isMainFrame: false })).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('treats a prompt that fails as a dismissal, and frees the tab', async () => {
    const { notifications, decisions, ask } = setup()
    ask.mockRejectedValue(new Error('window gone'))
    const tab = fakeTab(PAGE)
    expect(await notifications.request(tab, { requestingUrl: PAGE, isMainFrame: true })).toBe(false)
    expect(decisions.set).not.toHaveBeenCalled()
    expect(tabPromptState(tab).prompting).toBe(false)
  })
})

// The CHECK handler is what Notification.permission, the Permissions API and
// every notification the page shows are answered from, so it must agree
// with what the person said.
describe('site notifications: the check', () => {
  it('is true only for a site the person allowed', () => {
    const { notifications } = setup('allow', { [SITE]: 'allow', 'https://ads.example': 'block' })
    expect(notifications.check(`${SITE}/`, `${SITE}/`)).toBe(true)
    expect(notifications.check('https://ads.example/', 'https://ads.example/')).toBe(false)
    expect(notifications.check('https://never-asked.example/', undefined)).toBe(false)
  })

  it('agrees with an answer the moment it is given', async () => {
    const { notifications } = setup('allow')
    expect(notifications.check(`${SITE}/`, undefined)).toBe(false)
    await notifications.request(fakeTab(PAGE), { requestingUrl: PAGE, isMainFrame: true })
    expect(notifications.check(`${SITE}/`, undefined)).toBe(true)
  })

  it('is false for a frame of another site, even one the person allowed on its own', () => {
    const { notifications } = setup('allow', { 'https://ads.example': 'allow' })
    expect(notifications.check('https://ads.example/', `${SITE}/`)).toBe(false)
  })

  it('is false for an origin it cannot read, including the empty one Chromium sends before a page commits', () => {
    const { notifications } = setup('allow', { [SITE]: 'allow' })
    for (const origin of ['', 'null', 'file:///', 'not a url']) expect(notifications.check(origin, undefined)).toBe(false)
  })
})
