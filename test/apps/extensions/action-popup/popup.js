// Fixture popup script for test/e2e-extensions-toolbar.test.ts. Sets the
// title so the e2e test can prove the popup window loaded the right page,
// then calls chrome.tabs.query/chrome.tabs.create directly (a 'frame'-type
// extension context, per electron-chrome-extensions' own preload
// registration) and shows each reply as JSON, so the test can read the
// result back out of the popup's own DOM.
//
// #options is not driven by the e2e test (test file's own header: both
// chrome.runtime.openOptionsPage() and a direct chrome.tabs.create() to a
// chrome-extension: target crash the popup's own renderer here) -- kept as
// the realistic MV3 pattern for a later investigation to drive.
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
