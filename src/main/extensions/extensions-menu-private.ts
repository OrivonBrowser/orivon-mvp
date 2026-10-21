// What a private window's Extensions menu leaves out: removing an extension, which is done in a normal
// window, since the ones that run in a private window are copies that nothing is saved back from.
import type { MenuRowContext } from './extensions-menu-points.js'

/** `locked` on a row makes the page leave out the lines that change the installed extension. */
export const lockedRowPart = (_id: string, ctx: MenuRowContext): Record<string, unknown> => (ctx.win.services.isPrivate ? { locked: true } : {})
