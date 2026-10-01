// The default-browser host wired to the real machine. Nothing here runs at start-up: the registration is made
// only when the person presses the button in Settings.
import { app } from 'electron'
import type { DefaultBrowserHost } from './default-browser.js'

export const realDefaultBrowserHost: DefaultBrowserHost = {
  get isPackaged () { return app.isPackaged },
  get appImage () { return (process.env['APPIMAGE'] ?? '') !== '' },
  isDefault: (protocol) => app.isDefaultProtocolClient(protocol),
  setDefault: (protocol) => app.setAsDefaultProtocolClient(protocol)
}
