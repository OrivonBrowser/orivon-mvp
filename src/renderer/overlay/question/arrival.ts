/** What a double-press button reports to main about the pointer or focus being on it. */
export interface ArrivalPorts {
  /** Names the arrival or the departure to main. */
  send: (type: 'enter' | 'leave') => void
  /** The panel's guard is running: main ignores an arrival now, so none is sent. */
  isArming: () => boolean
  /** The button shows its own label again. */
  left: () => void
}

/**
 * Tracks whether main has been told the pointer or focus is on one button. Main arms a double-press
 * button only on an arrival after the guard: a pointer or focus that rested on the button through
 * the guard sends nothing until it leaves and arrives again, so someone clicking fast where the
 * panel appeared arms nothing.
 */
export function createArrival (ports: ArrivalPorts): { arrive: () => void, leave: () => void, restarted: () => void } {
  let here = false
  const arrive = (): void => {
    if (ports.isArming() || here) return
    here = true
    ports.send('enter')
  }
  return {
    arrive,
    leave: () => {
      if (!here) return
      here = false
      ports.left()
      ports.send('leave')
    },
    // Main forgets its arming when the guard starts over.
    restarted: () => { here = false }
  }
}
