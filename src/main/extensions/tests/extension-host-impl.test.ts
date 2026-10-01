import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ShellBridge } from '../extension-host-impl.js'

vi.mock('electron', () => ({ session: { defaultSession: { extensions: { getExtension: vi.fn() } } } }))
vi.mock('../../shell/window.js', () => ({ createShellWindow: vi.fn() }))

const { buildHostImpl } = await import('../extension-host-impl.js')

function bridgeWith (record: Record<string, unknown>): ShellBridge {
  const tabs = { faviconFor: () => null, record: () => record }
  return { services: { windows: { findTab: () => ({ window: { tabs }, tabId: 't1' }) } } } as unknown as ShellBridge
}

describe('buildHostImpl: assignTabDetails', () => {
  it('reports a sleeping tab as discarded, with the address and title it will wake to', () => {
    const host = buildHostImpl(() => bridgeWith({ pinned: false, sleeping: { url: 'https://a.example/', title: 'A', favicon: null } }))
    const details = { pinned: false, url: 'about:blank', title: '' }
    host.assignTabDetails?.(details as never, {} as WebContents)
    expect(details).toMatchObject({ discarded: true, url: 'https://a.example/', title: 'A' })
  })

  it('leaves an awake tab as the library built it', () => {
    const host = buildHostImpl(() => bridgeWith({ pinned: true }))
    const details: Record<string, unknown> = { pinned: false, url: 'https://b.example/', title: 'B' }
    host.assignTabDetails?.(details as never, {} as WebContents)
    expect(details).toEqual({ pinned: true, url: 'https://b.example/', title: 'B' })
  })
})
