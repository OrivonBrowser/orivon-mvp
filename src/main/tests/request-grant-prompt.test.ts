import { beforeEach, describe, expect, it, vi } from 'vitest'
import { manifestWith } from '../../broker/tests/index.test-helpers.js'
import { stubBroker } from '../../broker/transport/tests/ipc.test-helpers.js'
import type { Broker } from '../../broker/broker-contracts.js'

// createGrantPrompt imports 'electron' at module scope -- outside a real
// Electron process this cannot even be imported without mocking it first
// (same reasoning as tabs.test.ts's own header). This suite confirms the
// plumbing (the right dialog options reach dialog.showMessageBox, the
// right button maps to true/false, a manifest-read failure fails closed)
// -- WORDING is grant-prompt-render.test.ts's own job, unit-tested there
// against real Manifest values with no Electron import at all.

const showMessageBox = vi.fn()
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { createGrantPrompt } = await import('../request-grant-prompt.js')

const ORIGIN = 'https://app.example'

function brokerWithManifest (manifest: ReturnType<typeof manifestWith>): Broker {
  return stubBroker([], { manifest: async () => manifest })
}

describe('createGrantPrompt', () => {
  // showMessageBox is one shared mock across every test in this file --
  // reset its call log each time, or "not called" assertions below would
  // see calls left over from an earlier test.
  beforeEach(() => { showMessageBox.mockReset() })

  it('resolves true when the user picks the first (Allow) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    const consent = createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))

    const result = await consent(ORIGIN, 'fs', [])

    expect(result).toBe(true)
  })

  it('resolves false when the user picks the second (Deny) button', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const consent = createGrantPrompt(brokerWithManifest(manifestWith({ fs: {} })))

    const result = await consent(ORIGIN, 'fs', [])

    expect(result).toBe(false)
  })

  it('shows the rendered content -- origin as title, the composed message and detail', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const manifest = manifestWith({ net: { https: { connect: ['youtube.com:443'] } } })
    const consent = createGrantPrompt(brokerWithManifest(manifest))

    await consent(ORIGIN, 'https.connect', ['youtube.com:443'])

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: 'question',
      title: ORIGIN,
      message: 'Connect to youtube.com',
      detail: expect.stringContaining(manifest.name)
    }))
  })

  it('switches the native dialog type to "warning" for an unlimited declaration', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const manifest = manifestWith({ net: { https: { connect: ['*:*'] } } })
    const consent = createGrantPrompt(brokerWithManifest(manifest))

    await consent(ORIGIN, 'https.connect', ['*:*'])

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
  })

  it('fetches the manifest itself rather than trusting a widened ConsentPrompt signature', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    const manifest = manifestWith({ fs: {} })
    const fetchManifest = vi.fn(async () => manifest)
    const consent = createGrantPrompt(stubBroker([], { manifest: fetchManifest }))

    await consent(ORIGIN, 'fs', [])

    expect(fetchManifest).toHaveBeenCalledWith(ORIGIN)
  })

  it('fails closed -- denies with no dialog shown -- when the manifest cannot be read back', async () => {
    const consent = createGrantPrompt(stubBroker([], { manifest: async () => { throw new Error('internal') } }))

    const result = await consent(ORIGIN, 'fs', [])

    expect(result).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
