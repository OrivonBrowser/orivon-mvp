// Sessions that set a proxy of their own and answer for what it lets through. While the whole browser is on the tunnel,
// every session the runtime creates is stopped and then pointed at the shared front (`route-controller.ts`'s `adopt`);
// one marked here is left alone: the web contexts' discard-port proxy confines them harder than any front could, and the
// session that asks what the system's proxy is must not be pointed at a front or the question would always say "proxy".

const own = new WeakSet<object>()

/** Marks `session` as one that sets its own proxy. Call it right after creating the session, before awaiting anything. */
export function markOwnProxy (session: object): void {
  own.add(session)
}

export function hasOwnProxy (session: object): boolean {
  return own.has(session)
}

const system = new WeakSet<object>()

/** Marks `session` as the one that follows the system's proxy, whose requests are neither stopped nor tunnelled. */
export function markFollowsSystem (session: object): void {
  system.add(session)
}

/** Whether `session` is the one that follows the system's proxy. Such a session is not pointed at any tunnel, and a page loaded in it goes out as the system sends it. */
export function followsSystem (session: object): boolean {
  return system.has(session)
}
