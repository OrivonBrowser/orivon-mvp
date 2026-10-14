// What the verifier host reports of its reads from each local node: reads in flight now and bytes read, kept per node
// for the whole run. A host that sleeps or dies takes its own count with it, so its bytes are folded into the total first.

export class TrafficLedger {
  private readonly now = new Map<string, { active: number, bytes: number }>()
  private readonly before = new Map<string, number>()

  /** `known`: the nodes this build runs. The host parses hostile content, so a name it makes up is never kept. */
  constructor (private readonly known: ReadonlySet<string>) {}

  record (node: string, active: number, bytes: number): void {
    if (this.known.has(node)) this.now.set(node, { active, bytes })
  }

  read (node: string): { readonly active: number, readonly bytes: number } {
    const counted = this.now.get(node)
    return { active: counted?.active ?? 0, bytes: (this.before.get(node) ?? 0) + (counted?.bytes ?? 0) }
  }

  /** The host is gone or asleep: what it counted is kept, and nothing is in flight. */
  fold (): void {
    for (const [node, counted] of this.now) this.before.set(node, (this.before.get(node) ?? 0) + counted.bytes)
    this.now.clear()
  }
}
