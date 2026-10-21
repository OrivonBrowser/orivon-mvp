// What the verifier host reports of its reads from each local node: reads in flight now and bytes read, kept per node
// for the whole run. A host that sleeps or dies takes its own count with it, so its bytes are folded into the total first.
// A host that failed stays the running one until it exits, so its last reports can still arrive after the fold: they are
// ignored until the next host starts, because its figures are already in the total.

export class TrafficLedger {
  private readonly now = new Map<string, { active: number, bytes: number }>()
  private readonly before = new Map<string, number>()
  private folded = false

  /** `known`: the nodes this build runs. The host parses hostile content, so a name it makes up is never kept. */
  constructor (private readonly known: ReadonlySet<string>) {}

  record (node: string, active: number, bytes: number): void {
    if (!this.folded && this.known.has(node)) this.now.set(node, { active, bytes })
  }

  read (node: string): { readonly active: number, readonly bytes: number } {
    const counted = this.now.get(node)
    return { active: counted?.active ?? 0, bytes: (this.before.get(node) ?? 0) + (counted?.bytes ?? 0) }
  }

  /** The host is gone or asleep: what it counted is kept, and nothing is in flight. */
  fold (): void {
    this.folded = true
    for (const [node, counted] of this.now) this.before.set(node, (this.before.get(node) ?? 0) + counted.bytes)
    this.now.clear()
  }

  /** A new host starts: its reports count again. */
  open (): void {
    this.folded = false
  }
}
