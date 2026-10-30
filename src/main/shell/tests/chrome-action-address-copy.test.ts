import { describe, expect, it, vi } from 'vitest'
import { MAX_COPIED_FIELD } from '../../../renderer/chrome/address-copy.js'
import { addressCopy } from '../actions/address-copy.js'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { ChromeActionContext } from '../chrome-actions.js'
import { MAX_PASTED_LENGTH } from '../paste-and-go.js'

function context (copyAddress?: ChromeActionContext['copyAddress']): ChromeActionContext {
  return { window: {} as never, services: {} as never, ...(copyAddress === undefined ? {} : { copyAddress }) }
}

describe('the address.copy chrome action', () => {
  it('is registered', () => {
    expect(CHROME_ACTIONS['address.copy']).toBe(addressCopy)
  })

  it('puts the text of the field on the clipboard as an address, and says so', () => {
    const copyAddress = vi.fn()
    expect(runChromeAction('address.copy', { text: 'ipfs://explore.orivonstack.eth' }, context(copyAddress))).toBe(true)
    expect(copyAddress).toHaveBeenCalledExactlyOnceWith('ipfs://explore.orivonstack.eth')
  })

  it.each([undefined, null, 'ipfs://a.eth', 7, {}, { text: 7 }, { text: '' }, { text: ['ipfs://a.eth'] }, { text: { toString: () => 'x' } }, { text: 'x'.repeat(MAX_PASTED_LENGTH + 1) }])('writes nothing for the payload %j', (payload) => {
    const copyAddress = vi.fn()
    expect(runChromeAction('address.copy', payload, context(copyAddress))).toBe(false)
    expect(copyAddress).not.toHaveBeenCalled()
  })

  it('takes a text of the longest length it allows', () => {
    const copyAddress = vi.fn()
    expect(runChromeAction('address.copy', { text: 'x'.repeat(MAX_PASTED_LENGTH) }, context(copyAddress))).toBe(true)
  })

  it('answers false and logs when the clipboard refuses, and when there is none', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(runChromeAction('address.copy', { text: 'ipfs://a.eth' }, context(() => { throw new Error('no clipboard') }))).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
    log.mockRestore()
    expect(runChromeAction('address.copy', { text: 'ipfs://a.eth' }, context())).toBe(false)
  })

  it('takes as long a field as the chrome hands over', () => {
    expect(MAX_COPIED_FIELD).toBe(MAX_PASTED_LENGTH)
  })
})
