// Hash routing, because an app served from a pinned bundle has no server to
// answer a deep path: every asset the loader will serve is declared in the
// manifest, so `/watch?v=...` is a 404 by construction while `#/watch/...`
// is the same `index.html` every time.

function parseHash (hash) {
  const trimmed = hash.replace(/^#\/?/, '')
  if (trimmed.length === 0) return { name: 'home', args: [] }
  const [name, ...args] = trimmed.split('/')
  return { name, args: args.map((part) => decodeURIComponent(part)) }
}

export class Router {
  constructor (onRoute) {
    this.onRoute = onRoute
    this.current = { name: 'home', args: [] }
  }

  start () {
    globalThis.addEventListener('hashchange', () => { this.dispatch() })
    this.dispatch()
  }

  dispatch () {
    this.current = parseHash(globalThis.location.hash)
    this.onRoute(this.current)
  }

  static go (name, ...args) {
    globalThis.location.hash = `#/${[name, ...args.map((part) => encodeURIComponent(part))].join('/')}`
  }
}
