// Orivon patch: the script the store preload runs in the page's main world to put its APIs on
// `chrome`. Plain assignment let the renderer's own bindings rebuild (it fires when an extension
// loads) restore the native `chrome.webstorePrivate`, which main's status poll then reaches and
// crashes on; an accessor that refuses redefinition keeps ours in place. No `electron` import: the
// script is a string, so a unit test runs it in `node:vm`.

/** The source of the overrides, run through `webFrame.executeJavaScript`. It reads the objects the
 * preload exposes with `contextBridge` (`electronWebstore`, `electronManagement`,
 * `electronRuntime`) and sets up each override in its own `try`, so one that cannot be placed never
 * stops the others. */
export function storeOverridesScript(): string {
  return `
    (function () {
      var target = typeof chrome === 'object' ? chrome : null;
      if (target === null) return;
      try {
        Object.defineProperty(target, 'webstorePrivate', {
          get: function () { return electronWebstore; },
          set: function () {},
          enumerable: true,
          configurable: false
        });
      } catch (error) {}
      try {
        var management = Object.assign({}, target.management, electronManagement);
        Object.defineProperty(target, 'management', {
          get: function () { return management; },
          set: function () {},
          enumerable: true,
          configurable: false
        });
      } catch (error) {}
      try {
        if (target.runtime) Object.assign(target.runtime, electronRuntime);
      } catch (error) {}
    }());
    void 0;
  `
}
