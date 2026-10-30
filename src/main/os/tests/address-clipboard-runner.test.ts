import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  write: vi.fn(async (_items: unknown[]) => {}),
  writeText: vi.fn(async (_text: string) => {})
}))

vi.mock('electron', () => ({
  clipboard: { write: electron.write, writeText: electron.writeText },
  ClipboardItem: class {
    constructor (readonly data: Record<string, Blob>) {}
  }
}))

const { copyAddress, copyAddresses, copyAddressLogged, copyAddressesLogged, writeClip } = await import('../address-clipboard-runner.js')

/** The text of each format of the one item a `clipboard.write` call was given. */
async function formatsOf (call: number): Promise<Record<string, string>> {
  const [item] = electron.write.mock.calls[call]?.[0] as Array<{ data: Record<string, Blob> }>
  return Object.fromEntries(await Promise.all(Object.entries(item?.data ?? {}).map(async ([type, blob]) => [type, await blob.text()] as const)))
}

const failure = new Error('clipboard unavailable')
const settle = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)) }

beforeEach(() => {
  electron.write.mockReset().mockImplementation(async () => {})
  electron.writeText.mockReset().mockImplementation(async () => {})
})

describe('writeClip', () => {
  it('writes a clip with no link as text', async () => {
    await writeClip({ text: 'https://example.com/' })
    expect(electron.writeText).toHaveBeenCalledExactlyOnceWith('https://example.com/')
    expect(electron.write).not.toHaveBeenCalled()
  })

  it('writes a clip with a link as one item holding both formats', async () => {
    await writeClip({ text: 'ipfs://vitalik.eth', html: '<a href="https://vitalik.eth.limo/">ipfs://vitalik.eth</a>' })
    expect(electron.writeText).not.toHaveBeenCalled()
    expect(electron.write).toHaveBeenCalledTimes(1)
    expect(await formatsOf(0)).toEqual({ 'text/plain': 'ipfs://vitalik.eth', 'text/html': '<a href="https://vitalik.eth.limo/">ipfs://vitalik.eth</a>' })
  })

  it('resolves only once the write has', async () => {
    let finish: () => void = () => {}
    electron.write.mockImplementation(async () => await new Promise<void>((resolve) => { finish = resolve }))
    let done = false
    const written = writeClip({ text: 'a', html: '<b>a</b>' }).then(() => { done = true })
    await settle()
    expect(done).toBe(false)
    finish()
    await written
    expect(done).toBe(true)
  })

  it('rejects when the item write rejects, when the text write rejects and when either throws at the call', async () => {
    electron.write.mockRejectedValueOnce(failure)
    await expect(writeClip({ text: 'a', html: '<b>a</b>' })).rejects.toBe(failure)
    electron.writeText.mockRejectedValueOnce(failure)
    await expect(writeClip({ text: 'a' })).rejects.toBe(failure)
    electron.write.mockImplementationOnce(() => { throw failure })
    await expect(writeClip({ text: 'a', html: '<b>a</b>' })).rejects.toBe(failure)
    electron.writeText.mockImplementationOnce(() => { throw failure })
    await expect(writeClip({ text: 'a' })).rejects.toBe(failure)
  })
})

describe('copyAddress and copyAddresses', () => {
  it('put the address on the clipboard with its web link where there is one', async () => {
    await copyAddress('ipfs://vitalik.eth/a')
    expect(await formatsOf(0)).toEqual({ 'text/plain': 'ipfs://vitalik.eth/a', 'text/html': '<a href="https://vitalik.eth.limo/a">ipfs://vitalik.eth/a</a>' })
    await copyAddresses(['https://a.example/', 'orivon://settings'])
    expect(electron.writeText).toHaveBeenCalledExactlyOnceWith('https://a.example/\norivon://settings')
  })

  it('reject when the clipboard does', async () => {
    electron.write.mockRejectedValue(failure)
    electron.writeText.mockRejectedValue(failure)
    await expect(copyAddress('ipfs://vitalik.eth')).rejects.toBe(failure)
    await expect(copyAddresses(['https://a.example/'])).rejects.toBe(failure)
  })
})

describe('copyAddressLogged and copyAddressesLogged', () => {
  it('copy, and return nothing to wait for', async () => {
    expect(copyAddressLogged('ipfs://vitalik.eth')).toBeUndefined()
    expect(copyAddressesLogged(['https://a.example/'])).toBeUndefined()
    await settle()
    expect(electron.write).toHaveBeenCalledTimes(1)
    expect(electron.writeText).toHaveBeenCalledExactlyOnceWith('https://a.example/')
  })

  it('log a failed write and leave no rejection behind', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      electron.write.mockRejectedValue(failure)
      electron.writeText.mockImplementation(() => { throw failure })
      copyAddressLogged('ipfs://vitalik.eth')
      copyAddressesLogged(['https://a.example/'])
      await settle()
      await settle()
      expect(log).toHaveBeenCalledTimes(2)
      expect(log.mock.calls.every((call) => call[1] === failure)).toBe(true)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      log.mockRestore()
    }
  })
})
