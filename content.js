// 注入总结按钮
function injectButton() {
  if (document.getElementById('yt-summary-btn')) return;
  
  const button = document.createElement('button');
  button.id = 'yt-summary-btn';
  button.textContent = '📝 总结视频';
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 9999;
    padding: 10px 16px;
    background: #c00;
    color: white;
    border: none;
    border-radius: 9999px;
    font-size: 14px;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  `;
  
  button.onclick = () => {
    chrome.runtime.sendMessage({action: "openPopup"});
  };
  
  document.body.appendChild(button);
}

injectButton();

// 监听 YouTube SPA 导航
const observer = new MutationObserver(() => {
  if (window.location.pathname === '/watch') {
    setTimeout(injectButton, 1000);
  }
});

observer.observe(document.body, { childList: true, subtree: true });