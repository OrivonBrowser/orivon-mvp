import type { Crx } from './crx.js'

/** `chrome.sidePanel`, defined when the manifest declares the permission (required or optional). Calls reject with main's own message. */
export function sidePanelApi (): void {
  const crx = (globalThis as unknown as { __crx: Crx }).__crx
  if (!crx.declares('sidePanel')) return
  crx.define('sidePanel', (base) => ({
    ...base,
    setOptions: crx.call('sidePanel.setOptions'),
    getOptions: crx.call('sidePanel.getOptions'),
    setPanelBehavior: crx.call('sidePanel.setPanelBehavior'),
    getPanelBehavior: crx.call('sidePanel.getPanelBehavior'),
    getLayout: crx.call('sidePanel.getLayout'),
    open: crx.call('sidePanel.open'),
    close: crx.call('sidePanel.close'),
    onOpened: crx.event('sidePanel.onOpened'),
    onClosed: crx.event('sidePanel.onClosed')
  }))
}
