// The one empty document the shell answers for every served origin, so that a hidden page of the shell's own can be
// put at the origin in whichever session needs one: the partition an app used to run in, and the shared session the
// verifier relays the same handler into. The page runs nothing of the app's; the shell reads and writes the origin's
// storage through it (`../../main/storage-carry/`). The path holds a secret chosen at random when the process started,
// which no page can learn, so nothing the app or a website sends is ever taken for the shell's own request.

const TOKEN = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(18)), (byte) => byte.toString(16).padStart(2, '0')).join('')

/** The path of the empty document. */
export const CARRY_PAGE_PATH = `/.well-known/orivon/storage-carry-${TOKEN}`

const EMPTY_DOCUMENT = '<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>'

/** The address of the empty document at `origin`. */
export function carryPageUrl (origin: string): string {
  return `${new URL(origin).origin}${CARRY_PAGE_PATH}`
}

/** Whether `url` is the empty document of some origin. */
export function isCarryPageUrl (url: string): boolean {
  try {
    return new URL(url).pathname === CARRY_PAGE_PATH
  } catch {
    return false
  }
}

/** `handler`, answering the empty document itself and everything else as `handler` does. */
export function answeringCarryPage (handler: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' || !isCarryPageUrl(request.url)) return await handler(request)
    return new Response(EMPTY_DOCUMENT, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }
}
