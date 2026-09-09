import { inherits as nodeInherits } from 'node:util'
import { describe, expect, it } from 'vitest'
import { inherits } from '../node-util.js'

// Ground truth for every "throws" assertion below is real Node's own
// util.inherits (imported from node:util, never reimplemented here) --
// each test runs the same bad call through both and expects both to throw,
// which is proof of equivalence rather than "this function throws something".
describe('inherits', () => {
  it('throws when ctor is missing, matching real Node', () => {
    // @ts-expect-error -- exercising the runtime guard against a bad caller
    expect(() => inherits(undefined, function () {})).toThrow()
    // node:util's own type declares this parameter as `unknown`, so the
    // ground-truth call below needs no suppression.
    expect(() => nodeInherits(undefined, function () {})).toThrow()
  })

  it('throws when superCtor is missing, matching real Node', () => {
    // @ts-expect-error -- exercising the runtime guard against a bad caller
    expect(() => inherits(function () {}, undefined)).toThrow()
    expect(() => nodeInherits(function () {}, undefined)).toThrow()
  })

  it('throws when superCtor.prototype is missing, matching real Node', () => {
    const noPrototype = (() => {}).bind(null)
    expect(() => inherits(function () {}, noPrototype)).toThrow()
    expect(() => nodeInherits(function () {}, noPrototype)).toThrow()
  })

  it('makes an instance of ctor also an instance of superCtor', () => {
    function Sub (this: { value: number }, value: number) { this.value = value }
    function Super (this: unknown) {}
    inherits(Sub, Super)

    // Reflect.construct, not `new Sub(7)`: Sub's explicit `this` parameter
    // (needed for `this.value = value` to type-check) makes TypeScript treat
    // Sub as non-constructable, which is a type-level artifact of testing a
    // pre-ES6-class constructor -- not a real constraint `inherits` imposes.
    const instance = Reflect.construct(Sub, [7])
    expect(instance).toBeInstanceOf(Sub)
    expect(instance).toBeInstanceOf(Super)
    expect((instance as unknown as { value: number }).value).toBe(7)
  })

  it('sets ctor.super_ to superCtor, the legacy field real Node still sets', () => {
    function Sub () {}
    function Super () {}
    inherits(Sub, Super)
    expect((Sub as unknown as { super_: unknown }).super_).toBe(Super)
  })

  it('leaves a method defined only on superCtor.prototype reachable from a subclass instance', () => {
    function Sub (this: unknown) {}
    function Super (this: unknown) {}
    Super.prototype.greet = function () { return 'hi' }
    inherits(Sub, Super)

    const instance = Reflect.construct(Sub, [])
    expect((instance as unknown as { greet: () => string }).greet()).toBe('hi')
  })
})
