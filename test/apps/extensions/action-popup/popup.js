// Fixture popup script for test/e2e-extensions-toolbar.test.ts. Sets the
// title so the e2e test can prove the popup window loaded the right page,
// then calls chrome.tabs.query/chrome.tabs.create directly (a 'frame'-type
// extension context, per electron-chrome-extensions' own preload
// registration) and shows each reply as JSON, so the test can read the
// result back out of the popup's own DOM.
//
// #options calls chrome.runtime.openOptionsPage(), driven by the e2e test
// (its own header: sandboxed, it opens the options page as an ordinary
// tab).
document.title = 'Action Popup'

const result = document.getElementById('result')
const urlInput = document.getElementById('url')

document.getElementById('query').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({})
  result.textContent = JSON.stringify({ tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url })) })
})

document.getElementById('create').addEventListener('click', async () => {
  try {
    const tab = await chrome.tabs.create({ url: urlInput.value })
    result.textContent = JSON.stringify({ ok: true, tab: { id: tab.id, url: tab.url } })
  } catch (error) {
    result.textContent = JSON.stringify({ ok: false, error: String(error) })
  }
})

document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})
