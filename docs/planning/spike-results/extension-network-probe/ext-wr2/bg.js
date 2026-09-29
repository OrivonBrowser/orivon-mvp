chrome.webRequest.onBeforeRequest.addListener((d) => ({ cancel: d.url.includes('blocked.js') }), { urls: ['<all_urls>'] }, ['blocking'])
chrome.webRequest.onHeadersReceived.addListener((d) => ({ responseHeaders: d.responseHeaders.filter((h) => h.name.toLowerCase() !== 'content-security-policy') }), { urls: ['<all_urls>'], types: ['main_frame'] }, ['blocking', 'responseHeaders'])
