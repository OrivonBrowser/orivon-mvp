import type { DevicePermissionHandlerHandlerDetails } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindDevicePermissionHandler, handleDevicePermission } from '../device-permission-handler.js'

const details = (deviceType: string): DevicePermissionHandlerHandlerDetails =>
  ({ deviceType, origin: 'https://app.example', device: {} }) as unknown as DevicePermissionHandlerHandlerDetails

afterEach(() => { bindDevicePermissionHandler(undefined) })

describe('handleDevicePermission', () => {
  it('answers no until a handler is bound', () => {
    expect(handleDevicePermission(details('hid'))).toBe(false)
  })

  it('hands a HID device to the bound handler and returns its answer', () => {
    const handler = vi.fn(() => true)
    bindDevicePermissionHandler(handler)
    expect(handleDevicePermission(details('hid'))).toBe(true)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('never hands a USB or serial device to the handler', () => {
    const handler = vi.fn(() => true)
    bindDevicePermissionHandler(handler)
    expect(handleDevicePermission(details('usb'))).toBe(false)
    expect(handleDevicePermission(details('serial'))).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('answers no when the handler throws', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    bindDevicePermissionHandler(() => { throw new Error('broken') })
    expect(handleDevicePermission(details('hid'))).toBe(false)
    quiet.mockRestore()
  })
})
