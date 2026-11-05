import { describe, expect, it } from 'vitest'
import type { GpuDevice } from '../gpu-reading.js'
import { adapterReading, webGpuState, x11VulkanReadingOf } from '../webgpu-state.js'
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
    it('blames an X11 session on Linux for a page that got no adapter, though the bridge reads enabled', () => {
      const state = webGpuState(inputs({ session: 'x11', ozone: 'x11', devices: [NVIDIA], adapter: { kind: 'none' } }))
      expect(state).toMatchObject({ state: 'unavailable', reason: 'x11' })
      expect(state.sentence).toBe('WebGPU is off because this computer runs an X11 session. Chromium turns it off there for every graphics card. A site that needs WebGPU asks you for it. You can also turn it on in Settings, under Performance.')
    })

    it('says Orivon runs through XWayland when the session is Wayland and the browser is on X11', () => {
      const state = webGpuState(inputs({ session: 'wayland', ozone: 'x11', adapter: { kind: 'none' } }))
      expect(state).toMatchObject({ state: 'unavailable', reason: 'xwayland' })
      expect(state.sentence).toBe('WebGPU is off because Orivon is running through X11 (XWayland) on this Wayland session. WebGPU needs Orivon to run on Wayland.')
    })

    it('rules WebGPU out on X11 without a page, since Chromium never turns it on there', () => {
      expect(webGpuState(inputs({ session: 'x11', ozone: 'x11' }))).toMatchObject({ state: 'unavailable', reason: 'x11' })
      expect(webGpuState(inputs({ session: 'wayland', ozone: 'x11' }))).toMatchObject({ state: 'unavailable', reason: 'xwayland' })
    })

    it('does not call the computer an X11 session when the system names none', () => {
      for (const session of ['', 'tty']) {
        const state = webGpuState(inputs({ session, ozone: 'x11' }))
        expect(state).toMatchObject({ state: 'unavailable', reason: 'x11' })
        expect(state.sentence).toBe('WebGPU is off because Orivon is running on X11. Chromium turns it off there for every graphics card. A site that needs WebGPU asks you for it. You can also turn it on in Settings, under Performance.')
      }
    })

    it('does not read the bridge status, which reads enabled on real graphics cards where no adapter exists', () => {
      for (const features of [GOOD_FEATURES, BRIDGE_OFF, { webgpu: 'enabled' }]) {
        expect(webGpuState(inputs({ session: 'x11', ozone: 'x11', features, adapter: { kind: 'none' } })).reason).toBe('x11')
      }
    })

    it('does not blame X11 for a page that has no WebGPU at all', () => {
      expect(webGpuState(inputs({ ozone: 'x11', adapter: { kind: 'no-api' } }))).toMatchObject({ state: 'unavailable', reason: 'no-adapter' })
    })

    it('does not blame the session when it cannot tell which one it is', () => {
      expect(webGpuState(inputs({ ozone: '', features: BRIDGE_OFF })).state).toBe('unknown')
      expect(webGpuState(inputs({ ozone: '', adapter: { kind: 'none' } })).reason).toBe('no-adapter')
    })
  })

  describe('a graphics card Chromium gives no adapter on Wayland', () => {
    const TAIL = 'On Linux it does that for every card and driver not on its list.'
    const asked = (devices: readonly GpuDevice[] | undefined, over: Partial<WebGpuInputs> = {}): ReturnType<typeof webGpuState> =>
      webGpuState(inputs({ devices, adapter: { kind: 'none' }, ...over }))

    it('names the maker and the driver the way the device table does, for one graphics card', () => {
      const state = asked([AMD])
      expect(state).toMatchObject({ state: 'unavailable', reason: 'gpu-not-listed' })
      expect(state.sentence).toBe(`WebGPU is off because Chromium gave this graphics card (AMD) with this driver (24.2.1) no WebGPU adapter. ${TAIL}`)
    })

    it('names the driver vendor with its version when the report has one', () => {
      expect(asked([{ ...NVIDIA, driverVersion: '595.99.02' }]).sentence)
        .toBe(`WebGPU is off because Chromium gave this graphics card (NVIDIA) with this driver (NVIDIA 595.99.02) no WebGPU adapter. ${TAIL}`)
      expect(asked([INTEL]).sentence)
        .toBe(`WebGPU is off because Chromium gave this graphics card (Intel) with this driver (Mesa 25.1.3) no WebGPU adapter. ${TAIL}`)
    })

    it('names the maker the way the device rows do: the report\'s own name first', () => {
      expect(asked([device({ vendorId: 0x8086, vendorString: 'Intel Corporation', driverVersion: '1' })]).sentence).toContain('(Intel Corporation)')
    })

    it('leaves out a maker or a driver the report does not give, and does not print a number for it', () => {
      for (const unnamed of [device({}), device({ vendorId: 0 }), device({ vendorId: 0xabcd })]) {
        const state = asked([unnamed])
        expect(state.reason).toBe('gpu-not-listed')
        expect(state.sentence).toBe(`WebGPU is off because Chromium gave this graphics card with this driver no WebGPU adapter. ${TAIL}`)
      }
      expect(asked([device({ vendorId: 0x1002 })]).sentence)
        .toBe(`WebGPU is off because Chromium gave this graphics card (AMD) with this driver no WebGPU adapter. ${TAIL}`)
    })

    it('names no card of a hybrid computer alone, and lists the makers in device order', () => {
      const state = asked([{ ...NVIDIA, active: true }, { ...INTEL, active: false }])
      expect(state).toMatchObject({ state: 'unavailable', reason: 'gpu-not-listed' })
      expect(state.sentence).toBe(`WebGPU is off because Chromium gave none of this computer's graphics cards (NVIDIA, Intel) a WebGPU adapter. ${TAIL}`)
      expect(asked([INTEL, NVIDIA]).sentence).toContain('(Intel, NVIDIA)')
    })

    it('names each maker once, and leaves out the ones the report does not name', () => {
      expect(asked([INTEL, { ...INTEL, deviceId: 2 }]).sentence).toContain('graphics cards (Intel) a WebGPU adapter')
      expect(asked([INTEL, device({ vendorId: 0xabcd }), NVIDIA]).sentence).toContain('graphics cards (Intel, NVIDIA) a WebGPU adapter')
      expect(asked([device({}), device({ vendorId: 0xabcd })]).sentence)
        .toBe(`WebGPU is off because Chromium gave none of this computer's graphics cards a WebGPU adapter. ${TAIL}`)
    })

    it('counts only graphics cards, so a software renderer beside one does not make it a hybrid', () => {
      expect(asked([SWIFTSHADER, INTEL]).sentence)
        .toBe(`WebGPU is off because Chromium gave this graphics card (Intel) with this driver (Mesa 25.1.3) no WebGPU adapter. ${TAIL}`)
    })

    it('still blames the graphics card when the device list is not known', () => {
      const state = asked(undefined)
      expect(state.reason).toBe('gpu-not-listed')
      expect(state.sentence).toBe(`WebGPU is off because Chromium gave this graphics card no WebGPU adapter. ${TAIL}`)
    })

    it('does not read the bridge status, which reads enabled where no adapter exists', () => {
      for (const features of [GOOD_FEATURES, BRIDGE_OFF]) expect(asked([INTEL], { features }).reason).toBe('gpu-not-listed')
    })

    it('makes no claim without a page that saw no adapter, since a listed graphics card can get one', () => {
      expect(webGpuState(inputs({ devices: [INTEL, NVIDIA] }))).toMatchObject({ state: 'unknown', reason: 'unknown' })
      expect(webGpuState(inputs({ devices: [INTEL], adapter: { kind: 'no-api' } })).reason).toBe('no-adapter')
    })
  })

  it('says Chromium turned WebGPU off when no more specific reason shows', () => {
    for (const webgpu of ['disabled_off', 'unavailable_off', 'disabled_off_ok']) {
      expect(webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu } }))).toMatchObject({ state: 'unavailable', reason: 'webgpu-off' })
    }
    expect(webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu: 'disabled_off' } })).sentence)
      .toBe('Chromium has turned WebGPU off on this computer.')
  })

  it('gives the session as the reason when Chromium has turned WebGPU off as well', () => {
    const features = { ...GOOD_FEATURES, webgpu: 'disabled_off' }
    expect(webGpuState(inputs({ session: 'x11', ozone: 'x11', features })).reason).toBe('x11')
    expect(webGpuState(inputs({ ozone: 'wayland', features, adapter: { kind: 'none' } })).reason).toBe('gpu-not-listed')
    expect(webGpuState(inputs({ ozone: 'wayland', features })).reason).toBe('webgpu-off')
  })

  describe('pages drawn on the processor', () => {
    const SENTENCE = 'WebGPU is off because this computer draws pages on its processor, and Chromium does not allow WebGPU there. Chromium does that when there is no graphics card, when it blocks the card\'s driver, or after its graphics process has crashed several times.'

    it('gives software rendering as the reason before the session, as a computer with no graphics card is on X11 too', () => {
      const features = { webgpu: 'disabled_off', webgpu_on_vk_via_gl_interop: 'disabled_off', gpu_compositing: 'disabled_software' }
      expect(webGpuState(inputs({ ozone: 'x11', features, devices: [INTEL] })).reason).toBe('software-only')
      expect(webGpuState(inputs({ ozone: 'x11', features, devices: [INTEL], adapter: { kind: 'none' } })).reason).toBe('software-only')
      expect(webGpuState(inputs({ ozone: 'wayland', features, devices: [INTEL], adapter: { kind: 'none' } })).reason).toBe('software-only')
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
    const state = webGpuState(inputs({ ozone: '', adapter: { kind: 'none' } }))
    expect(state).toMatchObject({ state: 'unavailable', reason: 'no-adapter' })
    expect(state.sentence).toBe('The page asked for a WebGPU adapter and got none. The graphics report does not say why.')
    expect(webGpuState(inputs({ adapter: { kind: 'no-api' } })).sentence)
      .toBe('This page has no WebGPU. The graphics report does not say why.')
  })

  it('prefers a reason the report shows over the page\'s empty answer', () => {
    expect(webGpuState(inputs({ session: 'x11', ozone: 'x11', adapter: { kind: 'none' } })).reason).toBe('x11')
    expect(webGpuState(inputs({ features: { ...GOOD_FEATURES, webgpu: 'disabled_off' }, ozone: '', adapter: { kind: 'none' } })).reason).toBe('webgpu-off')
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
    const apple = [{ ...INTEL, vendorId: 0x106b }]
    expect(webGpuState({ platform: 'darwin', session: '', ozone: 'x11', features, devices: apple }).state).toBe('unknown')
    expect(webGpuState({ platform: 'darwin', session: 'wayland', ozone: 'wayland', features, devices: apple, adapter: { kind: 'none' } }).reason).toBe('no-adapter')
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


describe('the X11 setting for WebGPU', () => {
  const ON = { onAtStart: true, reverted: false }
  const REVERTED = { onAtStart: false, reverted: true }
  const x11 = (over: Partial<WebGpuInputs> = {}): WebGpuInputs => inputs({ session: 'x11', ozone: 'x11', devices: [NVIDIA], ...over })

  it('says the setting found no card, in the owner\'s words, when it is on and the page got no adapter', () => {
    const state = webGpuState(x11({ x11Vulkan: ON, adapter: { kind: 'none' } }))
    expect(state).toMatchObject({ state: 'unavailable', reason: 'x11-vulkan-no-adapter' })
    expect(state.sentence).toBe('WebGPU is still off with "Use the graphics card for WebGPU on X11" turned on: Chromium found no graphics card it could use through Vulkan.')
  })

  it('does not blame X11 for every card while the setting is on, and says nothing without a page', () => {
    expect(webGpuState(x11({ x11Vulkan: ON })).reason).toBe('unknown')
    expect(webGpuState(x11({ x11Vulkan: ON, adapter: { kind: 'no-api' } })).reason).toBe('no-adapter')
  })

  it('still answers available when the page got an adapter', () => {
    expect(webGpuState(x11({ x11Vulkan: ON, adapter: { kind: 'adapter' } }))).toMatchObject({ state: 'available', reason: 'adapter' })
  })

  it('says Orivon turned the setting off, with the way back, when it did and WebGPU is still off', () => {
    const state = webGpuState(x11({ x11Vulkan: REVERTED, adapter: { kind: 'none' } }))
    expect(state).toMatchObject({ state: 'unavailable', reason: 'x11-vulkan-reverted' })
    expect(state.sentence).toBe('Orivon turned off "Use the graphics card for WebGPU on X11" because graphics stopped working while it was on. You can turn it on again in Settings, under Performance.')
    expect(webGpuState(x11({ x11Vulkan: REVERTED })).reason).toBe('x11-vulkan-reverted')
  })

  it('puts the revert before the processor check, since a bad run is what leaves pages drawn there', () => {
    const software = { webgpu: 'disabled_off', gpu_compositing: 'disabled_software' }
    expect(webGpuState(x11({ x11Vulkan: REVERTED, features: software, adapter: { kind: 'none' } })).reason).toBe('x11-vulkan-reverted')
    expect(webGpuState(x11({ x11Vulkan: ON, features: software, adapter: { kind: 'none' } })).reason).toBe('software-only')
  })

  it('reads a revert in the run that went wrong and still has the switches when the page got none, or when pages are drawn on the processor', () => {
    const wrong = { onAtStart: true, reverted: true }
    const software = { webgpu: 'disabled_off', gpu_compositing: 'disabled_software' }
    expect(webGpuState(x11({ x11Vulkan: wrong, adapter: { kind: 'none' } })).reason).toBe('x11-vulkan-reverted')
    expect(webGpuState(x11({ x11Vulkan: wrong })).reason).toBe('unknown')
    expect(webGpuState(x11({ x11Vulkan: wrong, features: software })).reason).toBe('x11-vulkan-reverted')
    expect(webGpuState(x11({ x11Vulkan: wrong, features: software, adapter: { kind: 'none' } })).reason).toBe('x11-vulkan-reverted')
  })

  it('puts the revert before the processor check also when no page asked', () => {
    const software = { webgpu: 'disabled_off', gpu_compositing: 'disabled_software' }
    expect(webGpuState(x11({ x11Vulkan: REVERTED, features: software })).reason).toBe('x11-vulkan-reverted')
  })

  it('says one thing for every kind of revert: graphics stopped working', () => {
    expect(webGpuState(x11({ x11Vulkan: REVERTED })).sentence).toBe('Orivon turned off "Use the graphics card for WebGPU on X11" because graphics stopped working while it was on. You can turn it on again in Settings, under Performance.')
  })

  it('leaves the way to turn it on out of the sentences of a private window, whose switch is locked', () => {
    const x11Off = webGpuState(x11({ isPrivate: true, adapter: { kind: 'none' } }))
    expect(x11Off.reason).toBe('x11')
    expect(x11Off.sentence).toBe('WebGPU is off because this computer runs an X11 session. Chromium turns it off there for every graphics card.')
    const reverted = webGpuState(x11({ isPrivate: true, x11Vulkan: REVERTED, adapter: { kind: 'none' } }))
    expect(reverted.sentence).toBe('Orivon turned off "Use the graphics card for WebGPU on X11" because graphics stopped working while it was on.')
    expect(webGpuState(x11({ isPrivate: false, adapter: { kind: 'none' } })).sentence).toContain('You can also turn it on in Settings, under Performance.')
  })

  it('leaves the way back out of the sentence where Settings does not offer the choice (XWayland)', () => {
    const state = webGpuState(x11({ session: 'wayland', x11Vulkan: REVERTED, adapter: { kind: 'none' } }))
    expect(state.reason).toBe('x11-vulkan-reverted')
    expect(state.sentence).not.toContain('Settings')
  })

  it('names the setting only on X11 on Linux', () => {
    expect(webGpuState(inputs({ ozone: 'wayland', x11Vulkan: REVERTED, adapter: { kind: 'none' } })).reason).toBe('gpu-not-listed')
    expect(webGpuState({ platform: 'win32', session: '', ozone: '', features: WINDOWS_FEATURES, devices: [NVIDIA], adapter: { kind: 'none' }, x11Vulkan: REVERTED }).reason).toBe('no-adapter')
    expect(webGpuState(x11({ x11Vulkan: { onAtStart: false, reverted: false }, adapter: { kind: 'none' } })).reason).toBe('x11')
  })

  it('does not give the XWayland sentence the line about Settings', () => {
    expect(webGpuState(x11({ session: 'wayland', adapter: { kind: 'none' } })).sentence).not.toContain('Settings')
  })
})

describe('x11VulkanReadingOf', () => {
  it('keeps the start and turns a recorded revert into a flag, whatever its reason', () => {
    expect(x11VulkanReadingOf({ onAtStart: true, revert: null })).toEqual({ onAtStart: true, reverted: false })
    expect(x11VulkanReadingOf({ onAtStart: false, revert: { at: '2026-11-03T08:00:00.000Z', why: 'no-window' } })).toEqual({ onAtStart: false, reverted: true })
  })
})
