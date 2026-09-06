// A per-origin registry of live resources, keyed by origin then id.
//
// Exists for net.close (./ipc.ts): the control channel hands the renderer a
// bare id (SocketDescriptor.id), and a later net.close call must be able to
// find the real resource that id names -- but only if THIS origin is the one
// that was handed it. Looking a stale, unknown, or another-origin's id up
// finds nothing, matching TcpSocket.close()'s own "idempotent, silent no-op"
// contract (handle-contracts.md SSCommon shape) rather than distinguishing
// "wrong origin" from "already gone", either of which would let an app probe
// for handles it does not hold.

export interface PortRegistry<T> {
  register: (origin: string, id: string, value: T) => void
  get: (origin: string, id: string) => T | undefined
  remove: (origin: string, id: string) => void
}

export function createPortRegistry<T> (): PortRegistry<T> {
  const byOrigin = new Map<string, Map<string, T>>()

  return {
    register (origin, id, value) {
      let byId = byOrigin.get(origin)
      if (byId === undefined) {
        byId = new Map<string, T>()
        byOrigin.set(origin, byId)
      }
      byId.set(id, value)
    },
    get (origin, id) {
      return byOrigin.get(origin)?.get(id)
    },
    remove (origin, id) {
      const byId = byOrigin.get(origin)
      if (byId === undefined) return
      byId.delete(id)
      if (byId.size === 0) byOrigin.delete(origin)
    }
  }
}
