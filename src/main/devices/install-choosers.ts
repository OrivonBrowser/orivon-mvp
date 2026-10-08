// Wires WebHID (ADR-0068): the `hid` permission check, the device permission handler, the chooser for
// `navigator.hid.requestDevice()`, the question an app is asked for each device it only finds with `getDevices()`,
// and the page being told a device the person just allowed has appeared. The broker is read when a call arrives,
// because it is published after the installers run.
import { session as electronSession, webContents, type Session, type WebContents } from 'electron'
import { askChooser } from '../auth/ask-chooser.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { HID_ANNOUNCE_CHANNEL } from '../channels.js'
import { bindDevicePermissionHandler } from '../sessions/device-permission-handler.js'
import { siteAsks } from '../sessions/site-asks.js'
import type { ShellInstaller } from '../shell/shell-installers.js'
import { askQuestion } from '../shell/question/ask-question.js'
import { isRegisteredAppOrigin } from '../site-settings/app-origin.js'
import { createHidAsker, NO_ANSWER } from './hid-asker.js'
import { createHidGate } from './hid-gate.js'
import { deviceKey, hidInfoOf } from './hid-policy.js'
import { handleSelectHidDevice } from './hid-select.js'
import { createHidSiteAsker } from './hid-site-asker.js'

export const installChoosers: ShellInstaller = {
  name: 'choosers',
  install: (app, services, ctx) => {
    const approvals = services.hidDevices
    const blocked = (origin: string): boolean => services.siteSettings.get(origin, 'devices') === 'block' || services.settings.get('sites.devices') === 'block'

    const gate = createHidGate({
      approvals,
      isApp: (origin) => isRegisteredAppOrigin(ctx, origin),
      appPatterns: (origin) => ctx.broker?.app.grantedPatternsSync(origin, 'devices.hid'),
      siteBlocked: blocked,
      requestAsk: (origin, device) => { asker.ask(origin, device) }
    })

    const asker = createHidAsker<WebContents>({
      tabOf: (origin) => services.windows.liveTabsOn(origin)[0],
      appName: async (origin) => {
        try {
          return (await ctx.broker?.app.manifest(origin))?.name
        } catch {
          return undefined
        }
      },
      isAlive: (tab, origin) => !tab.isDestroyed() && originFromUrl(tab.getURL()) === origin,
      question: async (tab, spec) => {
        // The question ends as a cancel when the page navigates or closes, which is no answer from the person.
        let ended = false
        const end = (): void => { ended = true }
        tab.once('did-navigate', end)
        tab.once('destroyed', end)
        const result = await askQuestion({ contents: tab }, spec, { endOnNavigation: true })
        if (!tab.isDestroyed()) { tab.removeListener('did-navigate', end); tab.removeListener('destroyed', end) }
        return ended ? { ...result, response: NO_ANSWER } : result
      },
      approve: (origin, device) => approvals.approve(origin, device),
      decline: (origin, device) => { gate.decline(origin, device) },
      announce: (origin, devices) => {
        const triples = devices.map((device) => [device.vendorId, device.productId, device.name ?? ''])
        for (const tab of services.windows.liveTabsOn(origin)) {
          if (!tab.isDestroyed()) tab.mainFrame.send(HID_ANNOUNCE_CHANNEL, { devices: triples })
        }
      }
    })

    bindDevicePermissionHandler((details) => {
      const device = hidInfoOf(details.device)
      const origin = originFromUrl(details.origin)
      return device !== null && origin !== null && gate.devicePermission(origin, device)
    })

    // Before the per-site asker, which would otherwise refuse every app origin (shell-installers.ts keeps the order).
    siteAsks.add(createHidSiteAsker({
      isTab: (contents) => services.windows.findTab(contents) !== null,
      urlOf: (tab) => tab.getURL(),
      mayUse: (origin) => gate.mayUse(origin)
    }))

    const select = {
      gate,
      approve: (origin: string, device: Parameters<typeof approvals.approve>[1]) => approvals.approve(origin, device),
      target: (frame: Electron.WebFrameMain | null) => {
        const contents = frame === null ? undefined : webContents.fromFrame(frame)
        // A frame inside the page never gets a chooser: the page's own code is the only caller a device is for.
        if (frame === null || contents === undefined || contents.isDestroyed() || contents.mainFrame !== frame) return null
        const found = services.windows.findTab(contents)
        const origin = originFromUrl(frame.url)
        if (found === null || origin === null) return null
        return { origin, ask: async (spec: Parameters<typeof askChooser>[2]) => await askChooser(found.window, found.tabId, spec) }
      }
    }
    const attached = new WeakSet<Session>()
    const attach = (session: Session): void => {
      if (attached.has(session)) return
      attached.add(session)
      session.on('select-hid-device', (event, details, callback) => { handleSelectHidDevice(select, event, details, callback) })
      // `HIDDevice.forget()`: the page gives the device back, so the person's approval goes with it.
      session.on('hid-device-revoked', (_event, details) => {
        const device = hidInfoOf(details.device)
        const origin = originFromUrl(details.origin ?? '')
        if (device !== null && origin !== null) approvals.forget(origin, deviceKey(device))
      })
    }
    app.on('session-created', attach)
    attach(electronSession.defaultSession)
  }
}
