import { describe, expect, it } from 'vitest'
import { connectionSignal } from '../signals/connection.js'
import { appTabViews } from '../tab-partition.js'
import { signalState } from '../tab-signals.js'

const view = (): never => ({}) as never
const record = (over: Record<string, unknown> = {}): never => ({ view: view(), internalPage: null, ...over }) as never
const wc = (url: string): never => ({ getURL: () => url }) as never
const connectionOfTab = (rec: never, url: string): unknown => signalState(rec, wc(url), [connectionSignal])['connection']

describe('the connection signal', () => {
  it('reads the page\'s real URL on every push', () => {
    const rec = record()
    expect(connectionOfTab(rec, 'https://example.com/')).toBe('secure')
    expect(connectionOfTab(rec, 'http://example.com/')).toBe('insecure')
    expect(connectionOfTab(rec, 'http://localhost:3000/')).toBe('local')
  })

  it('has nothing for a destroyed page', () => {
    expect(signalState(record(), undefined, [connectionSignal])['connection']).toBe('none')
  })

  it('gives no lock to a gateway address or a name the verifier serves', () => {
    const rec = record()
    expect(connectionOfTab(rec, 'https://bafy.ipfs.orivon/x')).toBe('none')
    expect(connectionOfTab(rec, 'https://vitalik.eth/')).toBe('none')
    expect(connectionOfTab(rec, 'https://ipfs.orivon/bafy')).toBe('none')
  })

  it('gives no lock to an app tab or an internal page', () => {
    const appView = view()
    appTabViews.add(appView)
    expect(connectionOfTab(record({ view: appView }), 'https://app.example/')).toBe('none')
    expect(connectionOfTab(record({ internalPage: 'settings' }), 'https://example.com/')).toBe('none')
  })
})
