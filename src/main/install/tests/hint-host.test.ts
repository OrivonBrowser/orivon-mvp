import { describe, expect, it, vi } from 'vitest'
import type { TabScreens } from '../../app-setup/tab-screens.js'
import { hintHost } from '../hint-host.js'

function rig (moved = false): { host: ReturnType<typeof hintHost>, calls: string[], screens: TabScreens } {
  const calls: string[] = []
  const screens: TabScreens = {
    show: () => { calls.push('show') },
    sheet: async () => 'retry',
    end: () => { calls.push('end') },
    moved: () => moved,
    navigate: (url) => { calls.push(`navigate:${url}`) },
    leavePage: () => { calls.push('leavePage') }
  }
  const sender = { stop: vi.fn(() => { calls.push('stop') }), reload: vi.fn(() => { calls.push('reload') }), getURL: () => 'https://app.example/page' }
  const host = hintHost(sender, screens)
  return { host, calls, screens }
}

describe('hintHost: a first visit that began once the page was already running', () => {
  it('stops the page the first time a stage is shown, and only then', () => {
    const { host, calls } = rig()
    host.show({ kind: 'asking', name: 'L' })
    host.show({ kind: 'verifying', name: 'L' })
    expect(calls).toEqual(['stop', 'show', 'show'])
  })

  it('enters through the address bar\'s own path, so the app never loads in the session the page ran in', () => {
    const { host, calls } = rig()
    host.show({ kind: 'asking', name: 'L' })
    host.enter()
    expect(calls.slice(-2)).toEqual(['end', 'navigate:https://app.example/page'])
  })

  it('reloads a page it stopped when the site opens as a plain website, and leaves one it never touched alone', () => {
    const stopped = rig()
    stopped.host.show({ kind: 'asking', name: 'L' })
    stopped.host.plain()
    expect(stopped.calls.slice(-2)).toEqual(['end', 'reload'])
    const untouched = rig()
    untouched.host.plain()
    expect(untouched.calls).toEqual(['end'])
  })

  it('sends the tab away from a stopped page when the visit ends with the app not opened', () => {
    const { host, calls } = rig()
    host.show({ kind: 'asking', name: 'L' })
    host.end()
    expect(calls.slice(-2)).toEqual(['end', 'leavePage'])
  })

  it('leaves a tab alone that has already moved on', () => {
    const { host, calls } = rig(true)
    host.show({ kind: 'asking', name: 'L' })
    host.end()
    expect(calls).toEqual(['stop', 'show', 'end'])
  })

  it('hands the sheet to the tab\'s screens', async () => {
    const { host } = rig()
    await expect(host.sheet({ kind: 'download-failed', name: 'L', reason: 'x' })).resolves.toBe('retry')
  })
})
