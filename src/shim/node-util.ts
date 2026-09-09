// Node's `util` module, narrowed to the one export a real dependency graph
// calls (`k-rpc-socket`, underneath `bittorrent-dht` -> `webtorrent`: `util.
// inherits(RPC, events.EventEmitter)`). RULE 6, WRITTEN REASON: the npm
// `util` package would solve this by pulling four more packages
// (`is-arguments`, `is-generator-function`, `is-typed-array`,
// `which-typed-array`) to reach a function this shim can implement in ten
// lines, against an API that has been frozen since Node deprecated it in
// favour of ES6 classes. Extend this file, do not replace it with the
// package, if a real caller needs more of `util` -- see
// docs/planning/shim-dependency-review.md.
//
// Behaviour matches real Node's util.inherits exactly (verified in
// tests/node-util.test.ts against `node:util` itself, not against this
// file's own idea of correctness): validates both arguments and
// superCtor.prototype, sets the legacy `ctor.super_` field some callers
// still read, and rewires the prototype chain so `instanceof` and inherited
// methods both work on the subclass.

// Typed as `Function`, matching @types/node's own signature for
// util.inherits -- callers pass an ordinary pre-ES6-class constructor
// function, called both as `new Ctor()` and, by some libraries, plain
// (`Ctor.call(this, ...)`), so a `new (...) => unknown` signature would
// reject calls this shim must accept.

export function inherits (ctor: Function, superCtor: Function): void {
  if (ctor === undefined || ctor === null) {
    throw new TypeError('The "ctor" argument must be of type function')
  }
  if (superCtor === undefined || superCtor === null) {
    throw new TypeError('The "superCtor" argument must be of type function')
  }
  if (superCtor.prototype === undefined) {
    throw new TypeError('The "superCtor.prototype" property must be of type object')
  }

  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true })
  Object.setPrototypeOf(ctor.prototype as object, superCtor.prototype as object)
}
