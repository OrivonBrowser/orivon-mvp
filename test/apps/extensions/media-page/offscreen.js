chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen' || message.cmd !== 'ask') return undefined
  void window.__ask(message.constraints).then(sendResponse)
  return true
})
