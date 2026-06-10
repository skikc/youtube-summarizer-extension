chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getVideoId") {
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      const tab = tabs[0];
      if (tab.url.includes("youtube.com/watch")) {
        const url = new URL(tab.url);
        sendResponse({videoId: url.searchParams.get("v")});
      } else {
        sendResponse({error: "不在 YouTube 视频页面"});
      }
    });
    return true;
  }
});
