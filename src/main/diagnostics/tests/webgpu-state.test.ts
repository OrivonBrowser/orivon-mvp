import { describe, expect, it } from 'vitest'
import { adapterReading, gpuMakerName, webGpuInputsFrom, webGpuState } from '../webgpu-state.js'
import type { WebGpuDevice, WebGpuInputs } from '../webgpu-state.js'

const INTEL: WebGpuDevice = { vendorId: 0x8086, active: true, driverVendor: 'Mesa', driverVersion: '25.1.3' }
const NVIDIA: WebGpuDevice = { vendorId: 0x10de, active: true, driverVendor: 'NVIDIA', driverVersion: '535.104.05' }
const AMD: WebGpuDevice = { vendorId: 0x1002, active: true, driverVendor: '', driverVersion: '24.2.1' }
const SWIFTSHADER: WebGpuDevice = { vendorId: 0x1ae0, active: true, driverVendor: '', driverVersion: '5.0.0' }

const GOOD_FEATURES = { webgpu: 'enabled', webgpu_on_vk_via_gl_interop: 'enabled', vulkan: 'enabled_on', gpu_compositing: 'enabled' }

function inputs (over: Partial<WebGpuInputs> = {}): WebGpuInputs {
  return { platform: 'linux', ozone: 'wayland', features: GOOD_FEATURES, devices: [INTEL], ...over }
}

describe('webGpuState', () => {
  it('says WebGPU works when a page got an adapter, whatever else the report says', () => {
    const state = webGpuState(inputs({ ozone: 'x11', features: { webgpu: 'disabled_off' }, adapter: { kind: 'adapter' } }))
    expect(state).toMatchObject({ state: 'available', reason: 'adapter' })
    expect(state.sentence).toBe('WebGPU works on this computer.')
  })

  it('blames an X11 session on Linux when Chromium left the bridge off', () => {
    const state = webGpuState(inputs({ ozone: 'x11', features: { ...GOOD_FEATURES, webgpu_on_vk_via_gl_interop: 'disabled_off' }, devices: [NVIDIA] }))
    expect(state).toMatchObject({ state: 'unavailable', reason: 'x11' })
    expect(state.sentence).toBe('WebGPU is off because this computer runs an X11 session. Chromium turns it off there for every graphics card.')
  })

  it('does not blame X11 when the bridge is on', () => {
    expect(webGpuState(inputs({ ozone: 'x11' })).reason).not.toBe('x11')
  })

  it('names the maker and driver of a graphics card Chromium does not list on Wayland', () => {
    const state = webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu_on_vk_via_gl_interop: 'disabled_off' }, devices: [AMD, { ...NVIDIA, active: false }] }))
    expect(state).toMatchObject({ state: 'unavailable', reason: 'gpu-not-listed' })
    expect(state.sentence).toBe('WebGPU is off because Chromium turns it on for only a few graphics drivers on Linux, and this one (AMD, driver 24.2.1) is not among them.')
  })

  it('names the driver vendor with its version when the report has one', () => {
    const state = webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu_on_vk_via_gl_interop: 'unavailable_off' }, devices: [{ ...NVIDIA, active: false }, INTEL] }))
    expect(state.sentence).toContain('(Intel, driver Mesa 25.1.3)')
  })

  it('still blames the graphics card when the device list is not known', () => {
    const state = webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu_on_vk_via_gl_interop: 'disabled_off' }, devices: undefined }))
    expect(state.reason).toBe('gpu-not-listed')
    expect(state.sentence).toBe('WebGPU is off because Chromium turns it on for only a few graphics drivers on Linux, and this computer\'s is not among them.')
  })

  it('says Chromium turned WebGPU off when no more specific reason shows', () => {
    for (const webgpu of ['disabled_off', 'unavailable_off', 'disabled_off_ok']) {
      expect(webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu } }))).toMatchObject({ state: 'unavailable', reason: 'webgpu-off' })
    }
    expect(webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu: 'disabled_off' } })).sentence)
      .toBe('Chromium has turned WebGPU off on this computer.')
  })

  it('gives the session as the reason when WebGPU is off and the bridge is too', () => {
    const features = { ...GOOD_FEATURES, webgpu: 'disabled_off', webgpu_on_vk_via_gl_interop: 'disabled_off' }
    expect(webGpuState(inputs({ ozone: 'x11', features })).reason).toBe('x11')
    expect(webGpuState(inputs({ ozone: 'wayland', features })).reason).toBe('gpu-not-listed')
  })

  it('gives software rendering as the reason before the session, as a computer with no graphics card is on X11 too', () => {
    const features = { webgpu: 'disabled_off', webgpu_on_vk_via_gl_interop: 'disabled_off', gpu_compositing: 'disabled_software' }
    expect(webGpuState(inputs({ ozone: 'x11', features, devices: [INTEL] })).reason).toBe('software-only')
  })

  it('says Chromium blocks WebGPU on the processor when pages are drawn in software', () => {
    for (const features of [{ ...GOOD_FEATURES, gpu_compositing: 'disabled_software' }, { ...GOOD_FEATURES, webgpu: 'unavailable_software' }]) {
      const state = webGpuState(inputs({ ozone: 'x11', features }))
      expect(state).toMatchObject({ state: 'unavailable', reason: 'software-only' })
      expect(state.sentence).toBe('WebGPU needs a graphics card. This computer draws pages on its processor, and Chromium does not allow WebGPU there.')
    }
  })

  it('says the same when the only graphics device is a software renderer, or there is none', () => {
    expect(webGpuState(inputs({ devices: [SWIFTSHADER] })).reason).toBe('software-only')
    expect(webGpuState(inputs({ devices: [] })).reason).toBe('software-only')
    expect(webGpuState(inputs({ devices: [INTEL, SWIFTSHADER] })).reason).not.toBe('software-only')
  })

  it('does not call a missing device list software rendering', () => {
    expect(webGpuState(inputs({ devices: undefined })).state).toBe('unknown')
  })

  it('does not call Microsoft\'s software renderer a missing graphics card on Windows', () => {
    const warp = { vendorId: 0x1414, active: true, driverVendor: '', driverVersion: '10.0.26100.1' }
    expect(webGpuState({ platform: 'win32', ozone: '', features: { webgpu: 'enabled', gpu_compositing: 'enabled' }, devices: [warp] }).state).toBe('unknown')
  })

  it('names the maker of a Windows graphics card Chromium does not support', () => {
    const state = webGpuState({ platform: 'win32', ozone: '', features: { webgpu: 'enabled', gpu_compositing: 'enabled' }, devices: [{ vendorId: 0x13b5, active: true, driverVendor: '', driverVersion: '1.0' }] })
    expect(state).toMatchObject({ state: 'unavailable', reason: 'maker-unsupported' })
    expect(state.sentence).toBe('WebGPU is off because Chromium supports it on Windows only for AMD, Intel, NVIDIA and Qualcomm graphics cards, and this one is from Arm.')
  })

  it('accepts the Windows makers Chromium supports', () => {
    for (const vendorId of [0x1002, 0x8086, 0x10de, 0x5143]) {
      const state = webGpuState({ platform: 'win32', ozone: '', features: { webgpu: 'enabled', gpu_compositing: 'enabled' }, devices: [{ vendorId, active: true, driverVendor: '', driverVersion: '1' }] })
      expect(state.state).toBe('unknown')
    }
  })

  it('does not blame a Windows device whose report named no maker', () => {
    expect(webGpuState({ platform: 'win32', ozone: '', features: { webgpu: 'enabled', gpu_compositing: 'enabled' }, devices: [{ vendorId: 0, active: false, driverVendor: '', driverVersion: '' }] }).state).toBe('unknown')
  })

  it('names an unlisted vendor id by its number', () => {
    const state = webGpuState({ platform: 'win32', ozone: '', features: { webgpu: 'enabled', gpu_compositing: 'enabled' }, devices: [{ vendorId: 0xabcd, active: true, driverVendor: '', driverVersion: '1' }] })
    expect(state.sentence).toContain('this one is from the maker 0xabcd.')
  })

  it('says the page got no adapter when that is all it knows', () => {
    const state = webGpuState(inputs({ adapter: { kind: 'none' } }))
    expect(state).toMatchObject({ state: 'unavailable', reason: 'no-adapter' })
    expect(state.sentence).toBe('The page asked for a WebGPU adapter and got none. The graphics report does not say why.')
    expect(webGpuState(inputs({ adapter: { kind: 'no-api' } })).sentence)
      .toBe('This page has no WebGPU. The graphics report does not say why.')
  })

  it('prefers a reason the report shows over the page\'s empty answer', () => {
    expect(webGpuState(inputs({ ozone: 'x11', features: { ...GOOD_FEATURES, webgpu_on_vk_via_gl_interop: 'disabled_off' }, adapter: { kind: 'none' } })).reason).toBe('x11')
  })

  it('is unknown when nothing in the report rules WebGPU out or explains it', () => {
    const state = webGpuState(inputs())
    expect(state).toMatchObject({ state: 'unknown', reason: 'unknown' })
    expect(state.sentence).toBe('Orivon cannot tell from the graphics report whether WebGPU works on this computer.')
  })

  it('is unknown, never a guess, on a report with nothing in it', () => {
    expect(webGpuState({ platform: 'linux', ozone: '', features: {}, devices: undefined })).toMatchObject({ state: 'unknown', reason: 'unknown' })
  })

  it('does not blame the session when it cannot tell which one it is', () => {
    const features = { ...GOOD_FEATURES, webgpu_on_vk_via_gl_interop: 'disabled_off' }
    expect(webGpuState(inputs({ ozone: '', features })).state).toBe('unknown')
  })

  it('does not apply a Linux reason on another system', () => {
    const features = { webgpu: 'enabled', webgpu_on_vk_via_gl_interop: 'disabled_off', gpu_compositing: 'enabled' }
    expect(webGpuState({ platform: 'darwin', ozone: 'x11', features, devices: [{ ...INTEL, vendorId: 0x106b }] }).state).toBe('unknown')
  })
})

describe('gpuMakerName', () => {
  it('names the makers by their PCI vendor id', () => {
    expect(gpuMakerName(0x8086)).toBe('Intel')
    expect(gpuMakerName(0x10de)).toBe('NVIDIA')
    expect(gpuMakerName(0x1002)).toBe('AMD')
    expect(gpuMakerName(0x1)).toBeUndefined()
  })
})

describe('adapterReading', () => {
  it('believes only the three outcomes a page can report', () => {
    expect(adapterReading({ kind: 'adapter', vendor: 'intel' })).toEqual({ kind: 'adapter' })
    expect(adapterReading({ kind: 'none' })).toEqual({ kind: 'none' })
    expect(adapterReading({ kind: 'no-api' })).toEqual({ kind: 'no-api' })
    expect(adapterReading({ kind: 'working' })).toBeUndefined()
    expect(adapterReading('adapter')).toBeUndefined()
    expect(adapterReading(null)).toBeUndefined()
    expect(adapterReading(undefined)).toBeUndefined()
  })
})

describe('webGpuInputsFrom', () => {
  const status = { webgpu: 'enabled', gpu_compositing: 'enabled', note: 3 }
  const info = { gpuDevice: [{ vendorId: 0x8086, active: true, driverVendor: 'Mesa', driverVersion: '25.1.3', deviceString: 'ignored' }, {}] }

  it('keeps the string statuses and reads each device\'s four facts', () => {
    expect(webGpuInputsFrom({ platform: 'linux', ozone: 'wayland', status, info })).toEqual({
      platform: 'linux',
      ozone: 'wayland',
      features: { webgpu: 'enabled', gpu_compositing: 'enabled' },
      devices: [INTEL, { vendorId: 0, active: false, driverVendor: '', driverVersion: '' }]
    })
  })

  it('carries the page\'s adapter result when there is one', () => {
    expect(webGpuInputsFrom({ platform: 'linux', ozone: 'x11', status, info, adapter: { kind: 'none' } }).adapter).toEqual({ kind: 'none' })
  })

  it('has no device list when the report could not be read or has no list, rather than an empty one', () => {
    expect(webGpuInputsFrom({ platform: 'linux', ozone: 'x11', status, info: undefined }).devices).toBeUndefined()
    expect(webGpuInputsFrom({ platform: 'linux', ozone: 'x11', status, info: { auxAttributes: {} } }).devices).toBeUndefined()
    expect(webGpuInputsFrom({ platform: 'linux', ozone: 'x11', status, info: { gpuDevice: [] } }).devices).toEqual([])
  })

  it('has no features when the status is not an object', () => {
    expect(webGpuInputsFrom({ platform: 'linux', ozone: '', status: undefined, info }).features).toEqual({})
  })
})
