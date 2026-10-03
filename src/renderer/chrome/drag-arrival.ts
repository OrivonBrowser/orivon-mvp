// While another window drags a tab and screen positions are unknown (src/main/shell/local-pointer.ts), this
// window is the only one that can say whether the pointer was let go over it: it reports the first place the
// pointer appears over the chrome, in its own coordinates, and main takes it from there.

/** The slice of an event target the watch uses, so a test drives it without a document. */
export interface PointerTarget {
  addEventListener: (type: string, listener: (event: { clientX: number, clientY: number }) => void, options?: { capture: boolean }) => void
  removeEventListener: (type: string, listener: (event: { clientX: number, clientY: number }) => void, options?: { capture: boolean }) => void
}

const EVENTS = ['pointerover', 'pointermove']

export function createArrivalWatch (target: PointerTarget, report: (x: number, y: number) => void): { listen: (on: boolean) => void } {
  let listening = false
  const seen = (event: { clientX: number, clientY: number }): void => {
    stop()
    report(event.clientX, event.clientY)
  }
  function stop (): void {
    if (!listening) return
    listening = false
    for (const type of EVENTS) target.removeEventListener(type, seen, { capture: true })
  }
  return {
    listen: (on) => {
      if (!on) { stop(); return }
      if (listening) return
      listening = true
      for (const type of EVENTS) target.addEventListener(type, seen, { capture: true })
    }
  }
}
