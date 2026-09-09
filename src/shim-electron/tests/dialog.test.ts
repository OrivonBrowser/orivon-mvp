import { describe, expect, it } from 'vitest'
import { createDialog } from '../dialog.js'
import { ElectronShimError } from '../errors.js'
import type { Orivon } from '../../contracts/capability-api.js'

describe('createDialog', () => {
  it('throws a named not-built error for showOpenDialog when orivon.fs has no userSelected', async () => {
    const orivon = { fs: {} } as unknown as Pick<Orivon, 'fs'>
    const dialog = createDialog(orivon)
    await expect(dialog.showOpenDialog({})).rejects.toThrow(ElectronShimError)
    await dialog.showOpenDialog({}).catch((error: ElectronShimError) => {
      expect(error.reason).toBe('not-built')
      expect(error.api).toBe('dialog.showOpenDialog')
    })
  })

  it('rejects rather than throws synchronously, matching real Electron\'s promise-returning showOpenDialog', async () => {
    const orivon = { fs: {} } as unknown as Pick<Orivon, 'fs'>
    const dialog = createDialog(orivon)
    let synchronous: unknown
    const result = (() => {
      try {
        return dialog.showOpenDialog({})
      } catch (error) {
        synchronous = error
        return undefined
      }
    })()
    expect(synchronous).toBeUndefined()
    await expect(result).rejects.toThrow(ElectronShimError)
  })
})
