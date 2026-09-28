import { describe, expect, it } from 'vitest'
import { createBroker } from '../../../broker/index.js'
import { APP, baseDeps, manifestWith } from '../../../broker/tests/index.test-helpers.js'
import type { EmbedHost } from '../embed-host.js'

// embed-subsystem.ts imports `ipcMain` from 'electron' at module scope; the
// reply decision is imported through the same mock so the file loads.
import { vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
const { embedScriptReply } = await import('../embed-subsystem.js')

// ADR-0039: the script a shown page runs is decided from the SENDER's own
// identity -- a webview guest the host adopted, whose app still holds the
// grant -- never from anything a page could send.

function hostOwning (owners: Record<number, string>): EmbedHost {
  return { ownerOf: (id) => owners[id] }
}

async function brokerWithScript (source: string): Promise<ReturnType<typeof createBroker>> {
  const broker = createBroker(baseDeps())
  broker.registerApp(APP, manifestWith({ web: { embed: { origins: ['*'] } } }))
  await broker.grant(APP, 'web.embed', ['*'])
  await broker.embed.setScript(APP, { source })
  return broker
}

describe('embedScriptReply', () => {
  it('answers the app\'s script for a guest the host adopted', async () => {
    const broker = await brokerWithScript('window.probe = 1')
    const reply = embedScriptReply(hostOwning({ 7: APP }), broker, { id: 7, getType: () => 'webview' })
    expect(reply).toEqual({ source: 'window.probe = 1' })
  })

  it('answers null for a sender that is not a webview guest, even one the map names', async () => {
    const broker = await brokerWithScript('window.probe = 1')
    expect(embedScriptReply(hostOwning({ 7: APP }), broker, { id: 7, getType: () => 'window' })).toBeNull()
  })

  it('answers null for a guest the host never adopted', async () => {
    const broker = await brokerWithScript('window.probe = 1')
    expect(embedScriptReply(hostOwning({}), broker, { id: 7, getType: () => 'webview' })).toBeNull()
  })

  it('answers null once the app\'s grant is gone', async () => {
    const broker = await brokerWithScript('window.probe = 1')
    const [grant] = await broker.app.grants(APP)
    if (grant === undefined) throw new Error('no grant')
    await broker.revoke(APP, grant.id)
    expect(embedScriptReply(hostOwning({ 7: APP }), broker, { id: 7, getType: () => 'webview' })).toBeNull()
  })

  it('answers null when the app set no script', async () => {
    const broker = createBroker(baseDeps())
    broker.registerApp(APP, manifestWith({ web: { embed: { origins: ['*'] } } }))
    await broker.grant(APP, 'web.embed', ['*'])
    expect(embedScriptReply(hostOwning({ 7: APP }), broker, { id: 7, getType: () => 'webview' })).toBeNull()
  })
})
