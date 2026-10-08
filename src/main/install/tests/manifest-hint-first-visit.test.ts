import { describe, expect, it, vi } from 'vitest'
import { createManifestHintListener } from '../manifest-hint.js'
import type { HintVisits, InstallApp } from '../manifest-hint.js'
import { APP, frameFor } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { LoadResult } from '../../../loader/index.js'
import type { TabScreens } from '../../app-setup/tab-screens.js'
import type { FirstVisit, FirstVisitResult, SetupHost } from '../first-visit.js'

// A page that reports its manifest hint is a first visit when Orivon has never held its origin (ADR-0074):
// the question and the download come before the app is entered, and a refused origin is left alone.

const REJECTED: LoadResult = { outcome: 'rejected', reason: 'unused' }
async function flush (): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)) }

function rig (options: { kind?: 'first' | 'declined' | 'known', result?: FirstVisitResult, screens?: boolean, wired?: boolean } = {}): {
  listener: ReturnType<typeof createManifestHintListener>
  installApp: ReturnType<typeof vi.fn<InstallApp>>
  run: ReturnType<typeof vi.fn>
  hosts: SetupHost[]
  stop: ReturnType<typeof vi.fn>
} {
  const installApp = vi.fn<InstallApp>(async () => REJECTED)
  const hosts: SetupHost[] = []
  const run = vi.fn(async (_origin: string, _url: string, _caller: unknown, host: SetupHost): Promise<FirstVisitResult> => { hosts.push(host); return options.result ?? { outcome: 'left' } })
  const visit: FirstVisit = { kindOf: async () => options.kind ?? 'first', run: run as unknown as FirstVisit['run'] }
  const screens: TabScreens = { show: vi.fn(), sheet: async () => 'leave', end: vi.fn(), moved: () => false, navigate: vi.fn(), leavePage: vi.fn() }
  const visits: HintVisits = { firstVisit: () => options.wired === false ? undefined : visit, screensFor: () => options.screens === false ? undefined : screens }
  const stop = vi.fn()
  const listener = createManifestHintListener(installApp, undefined, undefined, undefined, visits)
  const original = listener
  return { listener: (event, url) => { (event.sender as unknown as { stop: unknown }).stop = stop; (event.sender as unknown as { getURL: unknown }).getURL = () => `${APP}/page`; original(event, url) }, installApp, run, hosts, stop }
}

describe('createManifestHintListener: the first visit', () => {
  it('runs the first visit for an origin Orivon has never held, and installs nothing the old way', async () => {
    const { listener, installApp, run } = rig()
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual([APP, `${APP}/.well-known/orivon.json`])
    expect(installApp).not.toHaveBeenCalled()
  })

  it('leaves an origin the person said no to alone: the site stays a plain website', async () => {
    const { listener, installApp, run } = rig({ kind: 'declined' })
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

  it('takes the ordinary path when the first visit is not wired, or the tab has no screens', async () => {
    for (const options of [{ wired: false }, { screens: false }]) {
      const { listener, installApp, run } = rig(options)
      listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
      await flush()
      expect(run).not.toHaveBeenCalled()
      expect(installApp).toHaveBeenCalledOnce()
    }
  })

  it('takes the ordinary path when another visit finished the origin first', async () => {
    const { listener, installApp } = rig({ result: { outcome: 'known' } })
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(installApp).toHaveBeenCalledOnce()
  })

  it('stops the page only when the first visit shows its first stage', async () => {
    const { listener, hosts, stop } = rig()
    listener(frameFor(APP), `${APP}/.well-known/orivon.json`)
    await flush()
    expect(stop).not.toHaveBeenCalled()
    hosts[0]!.show({ kind: 'asking', name: 'L' })
    expect(stop).toHaveBeenCalledOnce()
  })
})
