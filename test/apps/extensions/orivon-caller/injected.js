// Web-accessible resource, injected by isolated.js's own <script src> --
// this file's own execution IS the main-world case main-world-socket.ts's
// check names "web-accessible <script>". Reports the same way main-world.js
// does.
(async () => {
  function outcomeOf (error) {
    return (error && typeof error === 'object' && typeof error.code === 'string') ? error.code : String(error)
  }
  try {
    await window.orivon.app.manifest()
    document.documentElement.setAttribute('data-orivon-injected', 'allowed')
  } catch (error) {
    document.documentElement.setAttribute('data-orivon-injected', outcomeOf(error))
  }
})()
