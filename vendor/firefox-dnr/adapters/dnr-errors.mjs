/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adapter replacing ExtensionUtils.ExtensionError and ExtensionUtils.DefaultWeakMap
// (toolkit/components/extensions/ExtensionUtils.sys.mjs), which do not exist
// outside Firefox. See vendor/firefox-dnr/UPSTREAM.md patch 1.

/** Thrown for a rule/update rejected by validation; message text matches Chrome's. */
export class ExtensionError extends Error {}

/** A WeakMap whose #get creates and caches a value via `makeDefault` on first access. */
export class DefaultWeakMap extends WeakMap {
  constructor(makeDefault, entries) {
    super(entries)
    this.makeDefault = makeDefault
  }

  get(key) {
    if (!this.has(key)) {
      this.set(key, this.makeDefault(key))
    }
    return super.get(key)
  }
}
