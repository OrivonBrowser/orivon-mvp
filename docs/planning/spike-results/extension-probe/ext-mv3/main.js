(() => {
  const d = document.documentElement.dataset
  d.mainOrivonAtStart = typeof window.orivon
  setTimeout(() => { d.mainOrivonLater = typeof window.orivon }, 0)
  if (window.orivon) d.mainWhoami = JSON.stringify(window.orivon.whoami())
  const desc = Object.getOwnPropertyDescriptor(window, 'orivon')
  d.mainDesc = JSON.stringify(desc ? { writable: desc.writable, configurable: desc.configurable, enumerable: desc.enumerable } : null)
  d.mainFrozen = String(window.orivon ? Object.isFrozen(window.orivon) : null)
  if (!location.search.includes('mutate')) return
  try { window.orivon.whoami = () => 'wrapped'; d.mainWrapMethod = String(window.orivon.whoami() === 'wrapped') } catch (e) { d.mainWrapMethod = 'threw:' + e.message }
  try { window.orivon = { fake: true }; d.mainReplace = String(window.orivon.fake === true) } catch (e) { d.mainReplace = 'threw:' + e.message }
  try { Object.defineProperty(window, 'orivon', { value: { fake2: true } }); d.mainDefine = String(window.orivon.fake2 === true) } catch (e) { d.mainDefine = 'threw:' + e.message }
})()
