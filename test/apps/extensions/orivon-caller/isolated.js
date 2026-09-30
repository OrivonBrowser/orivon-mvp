// Isolated-world content script (manifest.json's own default-world entry):
// injects the web-accessible resource injected.js as a real <script src>,
// the route ADR-0021/main-world-socket.ts's README.md names as one of the
// ways an extension can put code in the page's main world. This script
// itself never sees window.orivon (the isolated world never does) -- only
// injected.js, once it runs there, does.
// Left in the DOM, unlike an inline injection: removing a src'd <script>
// element before it loads aborts the fetch, taking the resource with it.
const script = document.createElement('script')
script.src = chrome.runtime.getURL('injected.js')
document.documentElement.appendChild(script)
