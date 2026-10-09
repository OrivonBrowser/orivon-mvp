import { describe, expect, it, vi } from 'vitest'
import { createManifestHintListener } from '../manifest-hint.js'
import type { HintVisits, InstallApp } from '../manifest-hint.js'
import { APP, frameFor } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { LoadResult } from '../../../loader/index.js'
import type { TabScreens } from '../../app-setup/tab-screens.js'
import type { DialogCaller } from '../../consent/request-grant.js'
import type { FirstVisit, FirstVisitResult, SetupHost } from '../first-visit.js'

// A page that reports its manifest hint is a first visit when Orivon has never held its origin (ADR-0074):
// the question and the download come before the app is entered, a refused origin is left alone, and the old
// pin-before-consent path is for an app Orivon already holds, never a first visit.

const REJECTED: LoadResult = { outcome: 'rejected', reason: 'unused' }
async function flush (): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)) }

function rig (options: { kind?: 'first' | 'declined' | 'known' | 'settling', result?: FirstVisitResult, screens?: boolean, wired?: boolean, moved?: boolean } = {}): {
  listener: ReturnType<typeof createManifestHintListener>
  installApp: ReturnType<typeof vi.fn<InstallApp>>
  run: ReturnType<typeof vi.fn>
  hosts: SetupHost[]
  callers: Array<DialogCaller | undefined>
  screens: TabScreens
  reload: ReturnType<typeof vi.fn>
} {
  const installApp = vi.fn<InstallApp>(async () => REJECTED)
  const hosts: SetupHost[] = []
  const callers: Array<DialogCaller | undefined> = []
  const run = vi.fn(async (_origin: string, _url: string, caller: DialogCaller | undefined, host: SetupHost, _signal?: AbortSignal): Promise<FirstVisitResult> => { hosts.push(host); callers.push(caller); return options.result ?? { outcome: 'left' } })
  const visit: FirstVisit = { kindOf: async () => options.kind ?? 'first', run: run as unknown as FirstVisit['run'], resume: async () => {} }
  const screens: TabScreens = {
    show: vi.fn(), blank: vi.fn(async () => {}), sheet: async () => 'leave', end: vi.fn(), moved: () => options.moved === true, signal: new AbortController().signal, tab: () => ({ window: {}, tabId: 't' }) as never,
    navigate: vi.fn(), leavePage: vi.fn(), stop: vi.fn()
  }
  const visits: HintVisits = { firstVisit: () => options.wired === false ? undefined : visit, screensFor: () => options.screens === false ? undefined : screens }
  const reload = vi.fn()
  const listener = createManifestHintListener(installApp, undefined, undefined, undefined, visits)
  return {
    listener: (event, url) => {
      const sender = event.sender as unknown as Record<string, unknown>
      sender['getURL'] = () => `${APP}/page`
      sender['reload'] = reload
      listener(event, url)
    },
    installApp, run, hosts, callers, screens, reload
  }
}

describe('createManifestHintListener: the first visit', () => {
  it('runs the first visit for an origin Orivon has never held, and installs nothing the old way', async () => {
    const { listener, installApp, run } = rig()
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual([APP, `${APP}/.well-known/orivon.json`])
    expect(run.mock.calls[0]![4]).toBeInstanceOf(AbortSignal)
    expect(installApp).not.toHaveBeenCalled()
  })

  it('leaves an origin the person said no to alone: the site stays a plain website', async () => {
    const { listener, installApp, run } = rig({ kind: 'declined' })
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(installApp).not.toHaveBeenCalled()
  })

  it('installs nothing beside the download of an app that was let in a moment ago and is still coming down', async () => {
    const { listener, installApp, run } = rig({ kind: 'settling' })
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(installApp).not.toHaveBeenCalled()
  })

  it('takes the ordinary install path for an app Orivon already holds', async () => {
    const { listener, installApp, run } = rig({ kind: 'known' })
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(installApp).toHaveBeenCalledOnce()
  })

  it('takes the ordinary path only when the first visit is not wired at all', async () => {
    const { listener, installApp, run } = rig({ wired: false })
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(installApp).toHaveBeenCalledOnce()
  })

  it('runs the same order for contents no window holds, never the old pin-before-consent path', async () => {
    const { listener, installApp, run, hosts, reload } = rig({ screens: false })
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(installApp).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]![4]).toBeUndefined()
    expect(reload).not.toHaveBeenCalled()
    hosts[0]!.enter()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('takes the ordinary path when another visit finished the origin first', async () => {
    const { listener, installApp } = rig({ result: { outcome: 'known' } })
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(installApp).toHaveBeenCalledOnce()
  })

  it('takes the page down only when the first visit shows its first stage', async () => {
    const { listener, hosts, screens } = rig()
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(screens.blank).not.toHaveBeenCalled()
    await hosts[0]!.show({ kind: 'asking', name: 'L' })
    expect(screens.blank).toHaveBeenCalledOnce()
  })

  it('asks as the tab itself once its page is replaced: it is still there until the tab moves on', async () => {
    const stays = rig()
    stays.listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(stays.callers[0]!.stillOn(APP)).toBe(true)
    const leaves = rig({ moved: true })
    leaves.listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(leaves.callers[0]!.stillOn(APP)).toBe(false)
  })
})
