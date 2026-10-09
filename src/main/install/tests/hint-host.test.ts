import { describe, expect, it, vi } from 'vitest'
import type { TabScreens } from '../../app-setup/tab-screens.js'
import { headlessHost, hintHost } from '../hint-host.js'

const URL_ = 'https://app.example/page'

function rig (): { host: ReturnType<typeof hintHost>, calls: string[], screens: TabScreens, sender: { getURL: ReturnType<typeof vi.fn<() => string>> } } {
  const calls: string[] = []
  const TAB = { window: {}, tabId: 't' } as never
  const screens: TabScreens = {
    show: () => { calls.push('show') },
    blank: async () => { calls.push('blank') },
    sheet: async () => 'retry',
    end: () => { calls.push('end') },
    moved: () => false,
    signal: new AbortController().signal,
    tab: () => TAB,
    navigate: (url) => { calls.push(`navigate:${url}`) },
    leavePage: () => { calls.push('leavePage') },
    stop: () => { calls.push('stop') }
  }
  const sender = { getURL: vi.fn(() => URL_) }
  return { host: hintHost(sender, screens), calls, screens, sender }
}

describe('hintHost: a first visit that began once the page was already running', () => {
  it('replaces the running page with an empty one the first time a stage is shown, and only then', async () => {
    const { host, calls } = rig()
    await host.show({ kind: 'asking', name: 'L' })
    await host.show({ kind: 'verifying', name: 'L' })
    expect(calls).toEqual(['blank', 'show', 'show'])
  })

  it('waits for the page to be replaced before the first stage is drawn, so a question is never raised over a page that is still running', async () => {
    const order: string[] = []
    let release: () => void = () => {}
    const screens = { ...rig().screens, blank: async () => { await new Promise<void>((resolve) => { release = resolve }); order.push('blanked') }, show: () => { order.push('shown') } }
    const host = hintHost({ getURL: () => URL_ }, screens)
    const shown = host.show({ kind: 'asking', name: 'L' })
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await shown
    expect(order).toEqual(['blanked', 'shown'])
  })

  it('enters through the address bar\'s own path, at the address the hint came from', async () => {
    const { host, calls, sender } = rig()
    await host.show({ kind: 'asking', name: 'L' })
    sender.getURL.mockReturnValue('about:blank')
    host.enter()
    expect(calls.at(-1)).toBe(`navigate:${URL_}`)
  })

  it('takes the site back to the address as a plain website after it was replaced, and merely ends when it never was', async () => {
    const replaced = rig()
    await replaced.host.show({ kind: 'asking', name: 'L' })
    replaced.host.plain()
    expect(replaced.calls.at(-1)).toBe(`navigate:${URL_}`)
    const untouched = rig()
    untouched.host.plain()
    expect(untouched.calls).toEqual(['end'])
  })

  it('sends the tab away from the emptied page when the visit ends with the app not opened', async () => {
    const { host, calls } = rig()
    await host.show({ kind: 'asking', name: 'L' })
    host.end()
    expect(calls.at(-1)).toBe('leavePage')
    const untouched = rig()
    untouched.host.end()
    expect(untouched.calls).toEqual(['end'])
  })

  it('hands the sheet to the tab\'s screens', async () => {
    const { host } = rig()
    await expect(host.sheet({ kind: 'download-failed', name: 'L', reason: 'x' })).resolves.toBe('retry')
  })
})

describe('headlessHost: contents no window holds as a tab', () => {
  it('draws nothing, offers no retry, and reloads the contents to enter', async () => {
    const reload = vi.fn()
    const host = headlessHost({ reload, isDestroyed: () => false })
    host.show({ kind: 'asking', name: 'L' })
    await expect(host.sheet({ kind: 'download-failed', name: 'L', reason: 'x' })).resolves.toBe('leave')
    host.plain()
    host.end()
    expect(reload).not.toHaveBeenCalled()
    host.enter()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does not reload contents that are gone', () => {
    const reload = vi.fn()
    headlessHost({ reload, isDestroyed: () => true }).enter()
    expect(reload).not.toHaveBeenCalled()
  })
})
