import { describe, expect, it, vi } from 'vitest'
import { MAX_COPIED_FIELD } from '../../../renderer/chrome/address-copy.js'
import { addressCopy } from '../actions/address-copy.js'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { ChromeActionContext } from '../chrome-actions.js'
import { MAX_PASTED_LENGTH } from '../paste-and-go.js'

function context (copyAddress: ChromeActionContext['copyAddress']): { ctx: ChromeActionContext, toasts: () => string[] } {
  const show = vi.fn()
  const ctx = { window: { overlays: { show } } as never, services: {} as never, copyAddress }
  return { ctx, toasts: () => show.mock.calls.map((call) => (call[2] as { code: string }).code) }
}

describe('the address.copy chrome action', () => {
  it('is registered', () => {
    expect(CHROME_ACTIONS['address.copy']).toBe(addressCopy)
  })

  it('puts the text of the field on the clipboard as an address, and says so', async () => {
    const copyAddress = vi.fn(async () => {})
    const { ctx, toasts } = context(copyAddress)
    expect(await runChromeAction('address.copy', { text: 'ipfs://explore.orivonstack.eth' }, ctx)).toBe(true)
    expect(copyAddress).toHaveBeenCalledExactlyOnceWith('ipfs://explore.orivonstack.eth')
    expect(toasts()).toEqual([])
  })

  it('answers only once the write is done', async () => {
    let finish: () => void = () => {}
    const { ctx } = context(async () => await new Promise<void>((resolve) => { finish = resolve }))
    let answered = false
    const answer = (runChromeAction('address.copy', { text: 'ipfs://a.eth' }, ctx) as Promise<unknown>).then((value) => { answered = true; return value })
    await Promise.resolve()
    expect(answered).toBe(false)
    finish()
    expect(await answer).toBe(true)
  })

  it.each([undefined, null, 'ipfs://a.eth', 7, {}, { text: 7 }, { text: '' }, { text: ['ipfs://a.eth'] }, { text: { toString: () => 'x' } }, { text: 'x'.repeat(MAX_PASTED_LENGTH + 1) }])('writes nothing for the payload %j', async (payload) => {
    const copyAddress = vi.fn(async () => {})
    const { ctx, toasts } = context(copyAddress)
    expect(await runChromeAction('address.copy', payload, ctx)).toBe(false)
    expect(copyAddress).not.toHaveBeenCalled()
    expect(toasts()).toEqual([])
  })

  it('takes a text of the longest length it allows', async () => {
    const { ctx } = context(async () => {})
    expect(await runChromeAction('address.copy', { text: 'x'.repeat(MAX_PASTED_LENGTH) }, ctx)).toBe(true)
  })

  it('answers false, logs and says the copy failed when the clipboard refuses', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctx, toasts } = context(async () => { throw new Error('no clipboard') })
    expect(await runChromeAction('address.copy', { text: 'ipfs://a.eth' }, ctx)).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    expect(toasts()).toEqual(['linkCopyFailed'])
    log.mockRestore()
  })

  it('answers false and says so when the write throws at the call', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { ctx, toasts } = context(() => { throw new Error('no clipboard') })
    expect(await runChromeAction('address.copy', { text: 'ipfs://a.eth' }, ctx)).toBe(false)
    expect(toasts()).toEqual(['linkCopyFailed'])
    log.mockRestore()
  })

  it('takes as long a field as the chrome hands over', () => {
    expect(MAX_COPIED_FIELD).toBe(MAX_PASTED_LENGTH)
  })
})
