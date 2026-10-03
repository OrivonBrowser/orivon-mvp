import { afterEach, describe, expect, it, vi } from 'vitest'

const send = vi.fn()
vi.mock('electron', () => ({ ipcRenderer: { send: (...args: unknown[]) => { send(...args) } } }))

const { installPageKeys } = await import('../page-keys.js')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  send.mockReset()
})

function install (): (event: Record<string, unknown>) => void {
  let listener: ((event: Record<string, unknown>) => void) | undefined
  const page = { addEventListener: (_type: string, handler: (event: Record<string, unknown>) => void) => { listener = handler } } as Record<string, unknown>
  page['top'] = page
  vi.stubGlobal('window', page)
  vi.stubGlobal('process', { ...process, argv: [...process.argv, '--orivon-app-tab'], platform: 'linux' })
  installPageKeys()
  if (listener === undefined) throw new Error('no listener')
  return listener
}

const chord = (isTrusted: boolean): Record<string, unknown> => ({ key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false, isTrusted })

describe('installPageKeys', () => {
  it('asks for the find bar on a Ctrl+F the person pressed and nobody took, and never on one a script made', () => {
    vi.useFakeTimers()
    const listener = install()
    listener(chord(false))
    vi.runAllTimers()
    expect(send).not.toHaveBeenCalled()
    listener(chord(true))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
