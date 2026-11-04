import { describe, expect, it, vi } from 'vitest'
import { SETTINGS } from '../../../main/settings/schema.js'
import type { Row } from '../settings/model.js'
import { toggleState } from '../settings/rows.js'
import { graphicsRows } from '../settings/sections/rows/graphics.js'
import { SettingsState } from '../settings/state.js'
import type { OrivonInternal } from '../shared/bridge.js'

const KEY = 'graphics.webgpuOnX11'
const REVERT = { at: '2026-11-04T10:00:00.000Z', why: 'gpu-crash' }

async function loaded (options: { value: boolean, atStart: boolean, offered?: boolean, revert?: unknown, isPrivate?: boolean }): Promise<{ state: SettingsState, request: ReturnType<typeof vi.fn> }> {
  const { value, atStart, offered = true, revert = null, isPrivate = false } = options
  const request = vi.fn(async (domain: string) => {
    if (domain === 'settings') return await Promise.resolve({ descriptions: [], values: { [KEY]: value }, atStart: { [KEY]: atStart } })
    if (domain === 'profiles') return await Promise.resolve({ profiles: [], isPrivate })
    if (domain === 'graphics') return await Promise.resolve({ offered, revert })
    return await Promise.resolve({})
  })
  const state = new SettingsState({ request, onEvent: () => () => {} } as unknown as OrivonInternal)
  await state.load()
  return { state, request }
}

const row = (id: string): Row => graphicsRows.find((candidate) => candidate.id === id) as Row

describe('the WebGPU-on-X11 rows', () => {
  it('say what the owner approved, word for word', () => {
    expect(row('webgpu-on-x11').label).toBe('Use the graphics card for WebGPU on X11')
    expect(row('webgpu-on-x11').help).toBe('Turns on WebGPU, which some games and apps need, by drawing Orivon through Vulkan. On a laptop with two graphics cards this uses the stronger one, which drains the battery faster, and on some of them videos can show a blank picture, which is why Chromium leaves it off on X11. If the graphics process crashes, Orivon turns this off by itself. It is read when Orivon starts.')
    const restart = row('webgpu-on-x11-restart')
    expect(restart.label).toBe('Start again to apply')
    expect(restart.help).toBe('The choice above is read when Orivon starts. Your tabs and windows are not restored.')
    expect(restart.control.type === 'action' && restart.control.label).toBe('Restart Orivon')
  })

  it('belong to the Graphics group and to a setting that exists', () => {
    expect(row('webgpu-on-x11').group).toBe('Graphics')
    const control = row('webgpu-on-x11').control
    expect(control.type === 'toggle' && control.key).toBe(KEY)
    expect(Object.hasOwn(SETTINGS, KEY)).toBe(true)
  })

  it('are shown only where main offers the choice', async () => {
    // The restart row is judged by a choice that differs from the start, so both rows have something to show here.
    for (const id of ['webgpu-on-x11', 'webgpu-on-x11-restart']) {
      expect(row(id).visible?.((await loaded({ value: false, atStart: true, offered: true })).state), id).toBe(true)
      expect(row(id).visible?.((await loaded({ value: false, atStart: true, offered: false })).state), id).toBe(false)
    }
  })

  it('offer a restart only once the choice differs from the one this process started with', async () => {
    const restart = row('webgpu-on-x11-restart')
    expect(restart.visible?.((await loaded({ value: true, atStart: true })).state)).toBe(false)
    expect(restart.visible?.((await loaded({ value: false, atStart: false })).state)).toBe(false)
    expect(restart.visible?.((await loaded({ value: false, atStart: true })).state)).toBe(true)
    expect(restart.visible?.((await loaded({ value: true, atStart: false })).state)).toBe(true)
  })

  it('offer no restart in a private window, and grey the switch out there', async () => {
    const { state } = await loaded({ value: false, atStart: true, isPrivate: true })
    expect(row('webgpu-on-x11-restart').visible?.(state)).toBe(false)
    const control = row('webgpu-on-x11').control
    if (control.type !== 'toggle') throw new Error('not a toggle')
    expect(toggleState(control, state).disabled).toBe(true)
  })

  it('add the revert line to the help after Orivon turned the choice off, and not otherwise', async () => {
    const line = 'Orivon turned this off because the graphics process crashed while it was on.'
    const help = row('webgpu-on-x11').helpFor
    expect(help?.((await loaded({ value: false, atStart: true, revert: REVERT })).state)).toBe(`${row('webgpu-on-x11').help ?? ''} ${line}`)
    expect(help?.((await loaded({ value: false, atStart: false, revert: null })).state)).toBe(row('webgpu-on-x11').help)
    expect(help?.((await loaded({ value: true, atStart: false, revert: REVERT })).state)).toBe(row('webgpu-on-x11').help)
  })

  it('ask the application to start again', async () => {
    const { state, request } = await loaded({ value: false, atStart: true })
    const control = row('webgpu-on-x11-restart').control
    if (control.type !== 'action') throw new Error('not an action')
    await control.run(state)
    expect(request).toHaveBeenCalledWith('app', { type: 'relaunch' })
  })
})
