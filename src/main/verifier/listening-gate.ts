// Whether the verifier host can answer yet, as a request to a host it
// serves needs to know. Pure: the subsystem feeds it the host's events.

type Phase = 'pending' | 'listening' | 'down'

export class ListeningGate {
  private phase: Phase = 'pending'
  private readonly waiting = new Set<() => void>()

  /** `boundMs`: the longest one request waits for a host that says nothing. */
  constructor (private readonly boundMs: number) {}

  /** The host is being (re)started: requests wait for it again. */
  starting (): void { this.enter('pending') }

  listening (): void { this.enter('listening') }

  /** The host failed or exited: a held request goes on and fails the way it would without the gate. */
  down (): void { this.enter('down') }

  /** Resolves at once unless the host is still coming up; then when it listens, goes down, or the bound passes. */
  async whenSettled (): Promise<void> {
    if (this.phase !== 'pending') return
    await new Promise<void>((resolve) => {
      const release = (): void => {
        clearTimeout(timer)
        this.waiting.delete(release)
        resolve()
      }
      const timer = setTimeout(release, this.boundMs)
      this.waiting.add(release)
    })
  }

  private enter (phase: Phase): void {
    this.phase = phase
    if (phase === 'pending') return
    for (const release of [...this.waiting]) release()
  }
}
