import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { recordTabCaptureInvocation } from '../extension-tab-capture-invocation.js'
import { hasRecentInvocation } from '../extension-tab-invocation.js'

// Reproduces the probable-crash pattern browser-action.ts's activateClick
// feeds this module on every real toolbar click: a real `WebContents`
// throws "Object has been destroyed" reading almost any property once
// destroyed, `isDestroyed()` excepted -- the tab's own `'destroyed'`
// listener fires exactly when that is already true, so reading `tab.id`
// (or `tab.getURL()`) from INSIDE it crashes the whole process
// (index.ts's own `exitOnUncaught`).
class FakeWebContents extends EventEmitter {
  private destroyedFlag = false
  constructor (private readonly _id: number, private url: string) { super() }
  private assertLive (): void {
    if (this.destroyedFlag) throw new Error('Object has been destroyed')
  }
  get id (): number { this.assertLive(); return this._id }
  getURL (): string { this.assertLive(); return this.url }
  setURL (url: string): void { this.url = url }
  isDestroyed (): boolean { return this.destroyedFlag }
  destroy (): void { this.destroyedFlag = true; this.emit('destroyed') }
}

let nextId = 0
function freshTabId (): number { nextId += 1; return nextId }

describe('recordTabCaptureInvocation: closing the tab (probable crash)', () => {
  it('never throws when the tab is closed', () => {
    const tab = new FakeWebContents(freshTabId(), 'https://example.test/')
    recordTabCaptureInvocation('ext-a', tab as unknown as import('electron').WebContents)

    expect(() => { tab.destroy() }).not.toThrow()
  })

  it('still clears the invocation grant when the tab is closed', () => {
    const tabId = freshTabId()
    const tab = new FakeWebContents(tabId, 'https://example.test/')
    recordTabCaptureInvocation('ext-a', tab as unknown as import('electron').WebContents)
    expect(hasRecentInvocation('ext-a', tabId)).toBe(true)

    tab.destroy()

    expect(hasRecentInvocation('ext-a', tabId)).toBe(false)
  })

  it('never throws when the same tab is closed after two different extensions were both invoked on it', () => {
    const tabId = freshTabId()
    const tab = new FakeWebContents(tabId, 'https://example.test/')
    recordTabCaptureInvocation('ext-a', tab as unknown as import('electron').WebContents)
    recordTabCaptureInvocation('ext-b', tab as unknown as import('electron').WebContents)

    expect(() => { tab.destroy() }).not.toThrow()
    expect(hasRecentInvocation('ext-a', tabId)).toBe(false)
    expect(hasRecentInvocation('ext-b', tabId)).toBe(false)
  })
})
