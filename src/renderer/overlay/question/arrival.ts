/** What a double-press button reports to main about the pointer or focus being on it. */
export interface ArrivalPorts {
  /** Names the arrival or the departure to main. */
  send: (type: 'enter' | 'leave') => void
  /** The panel's guard is running: main ignores an arrival now, so none is sent. */
  isArming: () => boolean
  /** The pointer hovers the button or it holds the focus. */
  isOver: () => boolean
  /** The button shows its own label again. */
  left: () => void
}

/**
 * Tracks whether main has been told the pointer or focus is on one button. Main arms a double-press
 * button only on an arrival it takes after the guard, so an arrival that came during the guard is
 * sent again once it ends.
 */
export function createArrival (ports: ArrivalPorts): { arrive: () => void, leave: () => void, restarted: () => void, guardEnded: () => void } {
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
    restarted: () => { here = false },
    guardEnded: () => { if (ports.isOver()) arrive() }
  }
}
