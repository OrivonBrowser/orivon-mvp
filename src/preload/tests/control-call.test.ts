import { beforeEach, describe, expect, it, vi } from 'vitest'

// control-call.ts imports ipcRenderer from 'electron' at module scope, which
// plain Node cannot provide -- the same mock orivon-surface.test.ts uses.
const invoke = vi.fn()
vi.mock('electron', () => ({ ipcRenderer: { invoke: (...args: unknown[]) => invoke(...args) } }))

const { call } = await import('../control-call.js')

beforeEach(() => { invoke.mockReset() })

describe('call() -- an argument the IPC layer cannot send', () => {
  it('rejects \'invalid\' and says why, instead of an opaque internal failure', async () => {
    invoke.mockRejectedValue(new Error('An object could not be cloned.'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(call('fs.writeFile', { data: () => {} }, 1_000)).rejects.toMatchObject({
      name: 'OrivonError',
      code: 'invalid',
      message: expect.stringMatching(/fs\.writeFile.*could not be cloned/)
    })
    consoleError.mockRestore()
  })

  it('keeps any other transport failure \'internal\'', async () => {
    invoke.mockRejectedValue(new Error("Error invoking remote method 'orivon:control': boom"))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(call('app.manifest', {}, 1_000)).rejects.toMatchObject({ code: 'internal' })
    consoleError.mockRestore()
  })
})

describe('call() -- a refusal thrown rather than rejected', () => {
  it('takes the same path', async () => {
    invoke.mockImplementation(() => { throw new Error('An object could not be cloned.') })
    await expect(call('fs.writeFile', {}, 1_000)).rejects.toMatchObject({ code: 'invalid' })
  })
})
