import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ WebContentsView: vi.fn() }))

const { windowOpenHandler, processWindowBudget } = await import('../popups.js')

type Host = Parameters<typeof windowOpenHandler>[0]
type Details = Parameters<ReturnType<typeof windowOpenHandler>>[0]
type Choice = Awaited<ReturnType<NonNullable<Host['chooseLeave']>>>

const details = (url: string, features = '', disposition: Details['disposition'] = 'foreground-tab'): Details => ({
  url, frameName: '', features, disposition, referrer: { url: '', policy: 'default' }
})

const APP = { url: 'https://routed.example/app', partition: 'persist:app-routed' }
const SITE = 'https://news.example/story'

function setup (choice: Choice, leave: ReturnType<NonNullable<Host['leaveFor']>> = { kind: 'website', origin: 'https://news.example', app: 'https://routed.example' }) {
  const openTab = vi.fn(() => undefined)
  const openWindow = vi.fn(() => undefined)
  const openBlobTab = vi.fn(() => undefined)
  const chooseLeave = vi.fn(async () => choice)
  const host: Host = {
    atCapacity: () => false,
    openTab,
    adoptPopup: vi.fn(),
    openBlobTab,
    openWindow,
    partitionFor: () => undefined,
    webPreferencesFor: () => ({}),
    isApp: () => false,
    leaveFor: () => leave,
    chooseLeave
  }
  return { host, openTab, openWindow, openBlobTab, chooseLeave }
}

const settle = async (): Promise<void> => { await new Promise<void>((resolve) => { setImmediate(resolve) }) }

describe('a routed app opening a window outside its sessions', () => {
  it('refuses the open at once, so window.open returns null, and asks first', () => {
    processWindowBudget.reset()
    const { host, openTab, chooseLeave } = setup({ kind: 'cancel' })
    expect(windowOpenHandler(host, () => APP)(details(SITE)).action).toBe('deny')
    expect(chooseLeave).toHaveBeenCalledWith({ kind: 'website', origin: 'https://news.example', app: 'https://routed.example' })
    expect(openTab).not.toHaveBeenCalled()
  })

  it('opens nothing on Cancel', async () => {
    processWindowBudget.reset()
    const { host, openTab, openWindow, openBlobTab } = setup({ kind: 'cancel' })
    windowOpenHandler(host, () => APP)(details(SITE))
    await settle()
    expect(openTab).not.toHaveBeenCalled()
    expect(openWindow).not.toHaveBeenCalled()
    expect(openBlobTab).not.toHaveBeenCalled()
  })

  it('opens a tab in the temporary routed session on "through my tunnel", and never in the shared one', async () => {
    processWindowBudget.reset()
    const { host, openTab, openBlobTab } = setup({ kind: 'website', partition: 'orivon-route-tab-1' })
    windowOpenHandler(host, () => APP)(details(SITE))
    await settle()
    expect(openBlobTab).toHaveBeenCalledWith(SITE, 'orivon-route-tab-1', true, undefined)
    expect(openTab).not.toHaveBeenCalled()
  })

  it('opens it as it would with no route on "directly"', async () => {
    processWindowBudget.reset()
    const { host, openTab, openBlobTab } = setup({ kind: 'direct' })
    windowOpenHandler(host, () => APP)(details(SITE))
    await settle()
    expect(openTab).toHaveBeenCalledWith(SITE, true, undefined)
    expect(openBlobTab).not.toHaveBeenCalled()
  })

  it('opens another app, once its route is on, as an ordinary tab', async () => {
    processWindowBudget.reset()
    const { host, openTab } = setup({ kind: 'app' }, { kind: 'app', origin: 'https://other.example', app: 'https://routed.example' })
    windowOpenHandler(host, () => APP)(details('https://other.example/x'))
    await settle()
    expect(openTab).toHaveBeenCalledWith('https://other.example/x', true, undefined)
  })

  it('opens behind the current tab for a middle click', async () => {
    processWindowBudget.reset()
    const { host, openTab } = setup({ kind: 'direct' })
    windowOpenHandler(host, () => APP)({ ...details(SITE), disposition: 'background-tab' })
    await settle()
    expect(openTab).toHaveBeenCalledWith(SITE, false, undefined)
  })

  it('asks nothing when the open stays inside the app\'s sessions', () => {
    processWindowBudget.reset()
    const { host, chooseLeave, openTab } = setup({ kind: 'cancel' })
    const staying: Host = { ...host, leaveFor: () => undefined }
    windowOpenHandler(staying, () => APP)(details('https://routed.example/other'))
    expect(chooseLeave).not.toHaveBeenCalled()
    expect(openTab).toHaveBeenCalledOnce()
  })

  it('does not ask for a popup that asked for a window of its own: it is adopted into the app\'s routed session', () => {
    processWindowBudget.reset()
    const { host, chooseLeave } = setup({ kind: 'cancel' })
    const result = windowOpenHandler(host, () => APP)(details('https://accounts.example/auth', 'width=500,height=600', 'new-window'))
    expect(result.action).toBe('allow')
    expect(chooseLeave).not.toHaveBeenCalled()
  })

  it('asks for a popup that severs its opener, which is not adopted', () => {
    processWindowBudget.reset()
    const { host, chooseLeave } = setup({ kind: 'cancel' })
    expect(windowOpenHandler(host, () => APP)(details(SITE, 'noopener,width=500', 'new-window')).action).toBe('deny')
    expect(chooseLeave).toHaveBeenCalledOnce()
  })

  it('opens nothing when no way to ask is wired', async () => {
    processWindowBudget.reset()
    const { host, openTab } = setup({ kind: 'direct' })
    const { chooseLeave: _unused, ...withoutAsk } = host
    expect(windowOpenHandler(withoutAsk, () => APP)(details(SITE)).action).toBe('deny')
    await settle()
    expect(openTab).not.toHaveBeenCalled()
  })
})

describe('a page in a temporary routed session opening a window', () => {
  const TEMPORARY = { url: SITE, partition: 'orivon-route-tab-9' }

  it('opens a link to another website in the same session, without asking', () => {
    processWindowBudget.reset()
    const { host, openTab, openBlobTab, chooseLeave } = setup({ kind: 'cancel' })
    const plain: Host = { ...host, leaveFor: () => undefined }
    windowOpenHandler(plain, () => TEMPORARY)(details('https://other.example/'))
    expect(openBlobTab).toHaveBeenCalledWith('https://other.example/', 'orivon-route-tab-9', true, undefined)
    expect(openTab).not.toHaveBeenCalled()
    expect(chooseLeave).not.toHaveBeenCalled()
  })

  it('sends an installed app\'s address the ordinary way, to its own session', () => {
    processWindowBudget.reset()
    const { host, openTab, openBlobTab } = setup({ kind: 'cancel' })
    const plain: Host = { ...host, leaveFor: () => undefined, partitionFor: () => 'persist:app-other' }
    windowOpenHandler(plain, () => TEMPORARY)(details('https://other.example/'))
    expect(openBlobTab).not.toHaveBeenCalled()
    expect(openTab).toHaveBeenCalledOnce()
  })
})
