import { describe, expect, it } from 'vitest'
import type { GpuDevice } from '../gpu-reading.js'
import { adapterReading, webGpuState } from '../webgpu-state.js'
import type { WebGpuInputs } from '../webgpu-state.js'

function device (over: Partial<GpuDevice>): GpuDevice {
  return { vendorId: undefined, deviceId: undefined, vendorString: '', deviceString: '', driverVendor: '', driverVersion: '', active: true, ...over }
}

const INTEL = device({ vendorId: 0x8086, driverVendor: 'Mesa', driverVersion: '25.1.3' })
const NVIDIA = device({ vendorId: 0x10de, driverVendor: 'NVIDIA', driverVersion: '535.104.05' })
const AMD = device({ vendorId: 0x1002, driverVersion: '24.2.1' })
const SWIFTSHADER = device({ vendorId: 0x1ae0, driverVersion: '5.0.0' })

const GOOD_FEATURES = { webgpu: 'enabled', webgpu_on_vk_via_gl_interop: 'enabled', vulkan: 'enabled_on', gpu_compositing: 'enabled' }
const BRIDGE_OFF = { ...GOOD_FEATURES, webgpu_on_vk_via_gl_interop: 'disabled_off' }
const WINDOWS_FEATURES = { webgpu: 'enabled', gpu_compositing: 'enabled' }

function inputs (over: Partial<WebGpuInputs> = {}): WebGpuInputs {
  return { platform: 'linux', session: 'wayland', ozone: 'wayland', features: GOOD_FEATURES, devices: [INTEL], ...over }
}

/** A Windows report whose page, unless `over` says otherwise, asked for an adapter and got none. */
function windows (devices: GpuDevice[], over: Partial<WebGpuInputs> = {}): WebGpuInputs {
  return { platform: 'win32', session: '', ozone: '', features: WINDOWS_FEATURES, devices, adapter: { kind: 'none' }, ...over }
}

describe('webGpuState', () => {
  it('says WebGPU works when a page got an adapter, whatever else the report says', () => {
    const state = webGpuState(inputs({ ozone: 'x11', features: { webgpu: 'disabled_off' }, adapter: { kind: 'adapter' } }))
    expect(state).toMatchObject({ state: 'available', reason: 'adapter' })
    expect(state.sentence).toBe('WebGPU works on this computer.')
  })

  describe('X11', () => {
    it('blames an X11 session on Linux when Chromium left the bridge off', () => {
      const state = webGpuState(inputs({ session: 'x11', ozone: 'x11', features: BRIDGE_OFF, devices: [NVIDIA] }))
      expect(state).toMatchObject({ state: 'unavailable', reason: 'x11' })
      expect(state.sentence).toBe('WebGPU is off because this computer runs an X11 session. Chromium turns it off there for every graphics card.')
    })

    it('says Orivon runs through XWayland when the session is Wayland and the browser is on X11', () => {
      const state = webGpuState(inputs({ session: 'wayland', ozone: 'x11', features: BRIDGE_OFF }))
      expect(state).toMatchObject({ state: 'unavailable', reason: 'xwayland' })
      expect(state.sentence).toBe('WebGPU is off because Orivon is running through X11 (XWayland) on this Wayland session. WebGPU needs Orivon to run on Wayland.')
    })

    it('does not call the computer an X11 session when the system names none', () => {
      for (const session of ['', 'tty']) {
        const state = webGpuState(inputs({ session, ozone: 'x11', features: BRIDGE_OFF }))
        expect(state).toMatchObject({ state: 'unavailable', reason: 'x11' })
        expect(state.sentence).toBe('WebGPU is off because Orivon is running on X11. Chromium turns it off there for every graphics card.')
      }
    })

    it('does not blame X11 when the bridge is on', () => {
      expect(webGpuState(inputs({ ozone: 'x11' })).reason).not.toBe('x11')
    })

    it('does not blame the session when it cannot tell which one it is', () => {
      expect(webGpuState(inputs({ ozone: '', features: BRIDGE_OFF })).state).toBe('unknown')
    })
  })

  describe('a graphics card Chromium does not list on Wayland', () => {
    it('names the maker and the driver the way the device table does', () => {
      const state = webGpuState(inputs({ features: BRIDGE_OFF, devices: [AMD, { ...NVIDIA, active: false }] }))
      expect(state).toMatchObject({ state: 'unavailable', reason: 'gpu-not-listed' })
      expect(state.sentence).toBe('WebGPU is off because this graphics card (AMD) with this driver (24.2.1) is not on Chromium\'s list for Wayland.')
    })

    it('names the driver vendor with its version when the report has one', () => {
      const state = webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu_on_vk_via_gl_interop: 'unavailable_off' }, devices: [{ ...NVIDIA, active: false }, INTEL] }))
      expect(state.sentence).toBe('WebGPU is off because this graphics card (Intel) with this driver (Mesa 25.1.3) is not on Chromium\'s list for Wayland.')
    })

    it('names the maker the way the device rows do: the report\'s own name first', () => {
      const state = webGpuState(inputs({ features: BRIDGE_OFF, devices: [device({ vendorId: 0x8086, vendorString: 'Intel Corporation', driverVersion: '1' })] }))
      expect(state.sentence).toContain('(Intel Corporation)')
    })

    it('leaves out a maker the report does not name, and does not print a number for it', () => {
      for (const unnamed of [device({}), device({ vendorId: 0 }), device({ vendorId: 0xabcd })]) {
        const state = webGpuState(inputs({ features: BRIDGE_OFF, devices: [unnamed] }))
        expect(state.reason).toBe('gpu-not-listed')
        expect(state.sentence).toBe('WebGPU is off because this graphics card with this driver is not on Chromium\'s list for Wayland.')
      }
    })

    it('blames neither the driver alone nor Linux in general, since the list also looks at the card and matters only on Wayland', () => {
      const state = webGpuState(inputs({ features: BRIDGE_OFF, devices: [INTEL] }))
      expect(state.sentence).not.toMatch(/Linux|only a few graphics drivers/)
      expect(state.sentence).toContain('this graphics card (Intel) with this driver (Mesa 25.1.3)')
    })

    it('still blames the graphics card when the device list is not known', () => {
      const state = webGpuState(inputs({ features: BRIDGE_OFF, devices: undefined }))
      expect(state.reason).toBe('gpu-not-listed')
      expect(state.sentence).toBe('WebGPU is off because this graphics card with this driver is not on Chromium\'s list for Wayland.')
    })
  })

  it('says Chromium turned WebGPU off when no more specific reason shows', () => {
    for (const webgpu of ['disabled_off', 'unavailable_off', 'disabled_off_ok']) {
      expect(webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu } }))).toMatchObject({ state: 'unavailable', reason: 'webgpu-off' })
    }
    expect(webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu: 'disabled_off' } })).sentence)
      .toBe('Chromium has turned WebGPU off on this computer.')
  })

  it('gives the session as the reason when WebGPU is off and the bridge is too', () => {
    const features = { ...BRIDGE_OFF, webgpu: 'disabled_off' }
    expect(webGpuState(inputs({ session: 'x11', ozone: 'x11', features })).reason).toBe('x11')
    expect(webGpuState(inputs({ ozone: 'wayland', features })).reason).toBe('gpu-not-listed')
  })

  describe('pages drawn on the processor', () => {
    const SENTENCE = 'WebGPU is off because this computer draws pages on its processor, and Chromium does not allow WebGPU there. Chromium does that when there is no graphics card, when it blocks the card\'s driver, or after its graphics process has crashed several times.'

    it('gives software rendering as the reason before the session, as a computer with no graphics card is on X11 too', () => {
      const features = { webgpu: 'disabled_off', webgpu_on_vk_via_gl_interop: 'disabled_off', gpu_compositing: 'disabled_software' }
      expect(webGpuState(inputs({ ozone: 'x11', features, devices: [INTEL] })).reason).toBe('software-only')
    })

    it('does not say there is no graphics card, since Chromium also draws in software for a blocked driver or after crashes', () => {
      for (const features of [{ ...GOOD_FEATURES, gpu_compositing: 'disabled_software' }, { ...GOOD_FEATURES, webgpu: 'unavailable_software' }]) {
        const state = webGpuState(inputs({ ozone: 'x11', features }))
        expect(state).toMatchObject({ state: 'unavailable', reason: 'software-only' })
        expect(state.sentence).toBe(SENTENCE)
        expect(state.sentence).not.toMatch(/needs a graphics card/)
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

    it('does not count a device that names no vendor as a software renderer', () => {
      expect(webGpuState(inputs({ devices: [device({})] })).reason).not.toBe('software-only')
    })
  })

  describe('Windows', () => {
    it('does not call Microsoft\'s software renderer a missing graphics card on Windows', () => {
      const warp = device({ vendorId: 0x1414, driverVersion: '10.0.26100.1' })
      expect(webGpuState(windows([warp], { adapter: undefined })).state).toBe('unknown')
      expect(webGpuState(windows([warp])).reason).toBe('no-adapter')
    })

    it('names the maker of a graphics card Chromium does not support when the page got no adapter', () => {
      const state = webGpuState(windows([device({ vendorId: 0x13b5, driverVersion: '1.0' })]))
      expect(state).toMatchObject({ state: 'unavailable', reason: 'maker-unsupported' })
      expect(state.sentence).toBe('WebGPU is off because Chromium supports it on Windows only for AMD, Intel, NVIDIA and Qualcomm graphics cards, and this one is from Arm.')
    })

    it('makes no claim about the maker without a page that saw no adapter, since Windows\' own software renderer may still give one', () => {
      const arm = device({ vendorId: 0x13b5, driverVersion: '1.0' })
      expect(webGpuState(windows([arm], { adapter: undefined })).state).toBe('unknown')
      expect(webGpuState(windows([arm], { adapter: { kind: 'no-api' } })).reason).toBe('no-adapter')
      expect(webGpuState(windows([arm], { adapter: { kind: 'adapter' } })).state).toBe('available')
    })

    it('accepts the makers Chromium supports, and Microsoft\'s software renderer', () => {
      for (const vendorId of [0x1002, 0x8086, 0x10de, 0x5143, 0x1414]) {
        expect(webGpuState(windows([device({ vendorId, driverVersion: '1' })])).reason).toBe('no-adapter')
      }
    })

    it('does not blame a device whose report named no maker', () => {
      expect(webGpuState(windows([device({ vendorId: 0, active: false })])).reason).toBe('no-adapter')
      expect(webGpuState(windows([device({ active: false })])).reason).toBe('no-adapter')
    })

    it('names a maker with no name by its number, as the device table would', () => {
      const state = webGpuState(windows([device({ vendorId: 0xabcd, driverVersion: '1' })]))
      expect(state.sentence).toContain('and this one has the vendor id 0xabcd.')
    })

    it('names the maker the report gives before the one Orivon knows by number', () => {
      const state = webGpuState(windows([device({ vendorId: 0xabcd, vendorString: 'Acme' })]))
      expect(state.sentence).toContain('and this one is from Acme.')
    })

    it('says Chromium turned WebGPU off, not that the maker is unsupported, when its own status says off', () => {
      const state = webGpuState(windows([device({ vendorId: 0x13b5 })], { features: { webgpu: 'disabled_off', gpu_compositing: 'enabled' } }))
      expect(state.reason).toBe('webgpu-off')
    })
  })

  it('says the page got no adapter when that is all it knows', () => {
    const state = webGpuState(inputs({ adapter: { kind: 'none' } }))
    expect(state).toMatchObject({ state: 'unavailable', reason: 'no-adapter' })
    expect(state.sentence).toBe('The page asked for a WebGPU adapter and got none. The graphics report does not say why.')
    expect(webGpuState(inputs({ adapter: { kind: 'no-api' } })).sentence)
      .toBe('This page has no WebGPU. The graphics report does not say why.')
  })

  it('prefers a reason the report shows over the page\'s empty answer', () => {
    expect(webGpuState(inputs({ session: 'x11', ozone: 'x11', features: BRIDGE_OFF, adapter: { kind: 'none' } })).reason).toBe('x11')
  })

  it('is unknown when nothing in the report rules WebGPU out or explains it', () => {
    const state = webGpuState(inputs())
    expect(state).toMatchObject({ state: 'unknown', reason: 'unknown' })
    expect(state.sentence).toBe('Orivon cannot tell from the graphics report whether WebGPU works on this computer.')
  })

  it('is unknown, never a guess, on a report with nothing in it', () => {
    expect(webGpuState({ platform: 'linux', session: '', ozone: '', features: {}, devices: undefined })).toMatchObject({ state: 'unknown', reason: 'unknown' })
  })

  it('does not apply a Linux reason on another system', () => {
    const features = { webgpu: 'enabled', webgpu_on_vk_via_gl_interop: 'disabled_off', gpu_compositing: 'enabled' }
    expect(webGpuState({ platform: 'darwin', session: '', ozone: 'x11', features, devices: [{ ...INTEL, vendorId: 0x106b }] }).state).toBe('unknown')
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
