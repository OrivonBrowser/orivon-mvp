// A page that redraws by replacing its nodes puts the keyboard back where it was: each control a person can reach
// carries a `data-focus` key that stays the same across redraws, and the new control with the old one's key takes it.

/** Runs `draw`, then focuses the control under `root` whose `data-focus` matches the one that had the keyboard. */
export function redrawKeepingFocus (root: ParentNode, draw: () => void): void {
  const key = (document.activeElement as HTMLElement | null)?.dataset?.['focus']
  draw()
  if (key === undefined) return
  root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(key)}"]`)?.focus({ preventScroll: true })
}
