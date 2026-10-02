// Which frame a tab preload is running in. A tab's preload reaches the top
// frame only (`nodeIntegrationInSubFrames` is off), and each preload that
// exposes something to the page asks here first, so a setting that ever ran it
// in a subframe would not hand that frame `window.orivon` or the routed network.

/** True in the top frame. Anything but a plain `true` counts as a subframe, so a preload that cannot tell exposes nothing. */
export function inMainFrame (): boolean {
  return process.isMainFrame === true
}
