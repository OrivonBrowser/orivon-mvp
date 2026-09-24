/** At most `limit` tasks at once; the rest wait their turn in order. */
export class Slots {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor (private readonly limit: number) {}

  async run<T> (task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}
