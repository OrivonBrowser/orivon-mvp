// A tab's preloads also run in every subframe of the page (the tab's
// `nodeIntegrationInSubFrames`), so that a frame's own alert reaches the
// browser's panel. A subframe gets nothing else: no `window.orivon`, no routed
// network, no form watching. Each tab preload asks here before it exposes
// anything beyond the dialog wrapper.

/** True in the top frame. Anything but a plain `true` counts as a subframe, so a preload that cannot tell exposes nothing. */
export function inMainFrame (): boolean {
  return process.isMainFrame === true
}
