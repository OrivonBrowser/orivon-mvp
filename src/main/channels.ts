// The shell's two IPC channel names, shared between main (ipc.ts, window.ts)
// and preload/shell.ts -- previously the same two literals typed three times
// under different constant names, which a rename on either side could
// silently desynchronise (nothing else in this repo would have caught it;
// see docs/development/parallel-work.md's ownership table, where this file
// was added to the shell stream's paths). docs/development/code-guidelines.md
// Rule 3.

/** Chrome view -> main: tab commands (newTab, closeTab, navigate, ...). See ./ipc.ts. */
export const COMMAND_CHANNEL = 'orivon-shell:command'

/** Main -> chrome view: pushed tab state. See ./window.ts. */
export const STATE_CHANNEL = 'orivon-shell:state'

/** New-tab dashboard -> main: fetch bookmarks, or navigate the calling
 * tab. A separate channel from COMMAND_CHANNEL on purpose -- more than
 * one dashboard tab can exist at once, so its sender check (per call,
 * against the frame's own URL) is a different shape than the chrome
 * view's single-webContents identity check. See ./newtab-ipc.ts. */
export const NEWTAB_COMMAND_CHANNEL = 'orivon-newtab:command'
