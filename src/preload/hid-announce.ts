// A USB HID device the person just allowed for this page (ADR-0068). An app that only calls `navigator.hid.getDevices()`
// never asks again, so when main says a device is now usable this page's `navigator.hid` is told it has connected:
// the same `connect` event Chromium sends for a plugged-in device. Electron 44 builds `HIDConnectionEvent` with a null
// `device`, so the event gets an own `device` property, and it is built in the page's world because an event made in
// this one loses it. Main sends and the page cannot: the message arrives on a channel only the browser process writes.
import { contextBridge, ipcRenderer } from 'electron'
import { HID_ANNOUNCE_CHANNEL } from '../main/channels.js'
import { inMainFrame } from './frame.js'

/** `[vendorId, productId, productName]` of each device to announce: WebHID shows a page no serial number. */
type DeviceTriple = readonly [number, number, string]

/**
 * Runs in the page's main world through `contextBridge.executeInMainWorld`, so it closes over nothing from this
 * module. A device is announced only if the page's own `getDevices()` returns it, which Chromium answers from the
 * person's approval.
 */
function announceInMainWorld (triples: readonly DeviceTriple[]): void {
  const hid = (navigator as unknown as { hid?: EventTarget & { getDevices: () => Promise<Array<{ vendorId: number, productId: number, productName?: string }>> } }).hid
  const EventType = (globalThis as unknown as { HIDConnectionEvent?: new (type: string, init: object) => Event }).HIDConnectionEvent
  if (hid === undefined || EventType === undefined) return
  // A device object is announced once: the page's `getDevices()` hands back the same object for the same device.
  const marker = Symbol.for('orivon.hid.announced')
  const holder = hid as unknown as Record<symbol, WeakSet<object> | undefined>
  const announced = holder[marker] ?? new WeakSet<object>()
  Object.defineProperty(hid, marker, { value: announced, configurable: true })
  void hid.getDevices().then((devices) => {
    for (const device of devices) {
      const wanted = triples.some(([vendorId, productId, name]) =>
        device.vendorId === vendorId && device.productId === productId && (device.productName ?? '') === name)
      if (!wanted || announced.has(device)) continue
      announced.add(device)
      const event = new EventType('connect', { device })
      Object.defineProperty(event, 'device', { value: device, enumerable: true })
      hid.dispatchEvent(event)
    }
  }, () => {})
}

const isTriple = (value: unknown): value is DeviceTriple =>
  Array.isArray(value) && value.length === 3 && typeof value[0] === 'number' && typeof value[1] === 'number' && typeof value[2] === 'string'

/** Top frame only: a frame inside the page has no device to be told about. */
export function installHidAnnounce (): void {
  if (!inMainFrame()) return
  ipcRenderer.on(HID_ANNOUNCE_CHANNEL, (_event, message: unknown) => {
    const devices = (message as { devices?: unknown } | null)?.devices
    if (!Array.isArray(devices)) return
    const triples = devices.filter(isTriple)
    if (triples.length === 0) return
    contextBridge.executeInMainWorld({ func: announceInMainWorld, args: [triples] })
  })
}
