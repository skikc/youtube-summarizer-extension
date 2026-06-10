let currentTranscript = '';
let currentVideoId = '';

// ============ 持久化：保存 & 恢复上次抓取内容 ============
function saveState(summaryHtml) {
  chrome.storage.local.set({
    lastTranscript: currentTranscript,
    lastVideoId: currentVideoId,
    lastSummary: summaryHtml || document.getElementById('summary').innerHTML,
    lastStatus: document.getElementById('status').textContent,
    lastStatusClass: document.getElementById('status').className
  });
}

function restoreState() {
  chrome.storage.local.get(['lastTranscript', 'lastVideoId', 'lastSummary', 'lastStatus', 'lastStatusClass'], (r) => {
    if (r.lastTranscript) {
      currentTranscript = r.lastTranscript;
      currentVideoId = r.lastVideoId || '';
      showTranscriptSection(
        r.lastTranscript.substring(0, 8000) + (r.lastTranscript.length > 8000 ? '\n...（已截断）' : '')
      );
    }
    if (r.lastSummary) {
      document.getElementById('summary').innerHTML = r.lastSummary;
    }
    if (r.lastStatus) {
      document.getElementById('status').textContent = r.lastStatus;
      document.getElementById('status').className = r.lastStatusClass || '';
    }
  });
}

// ============ API Key 管理（含折叠） ============
function collapseApiKey() {
  document.getElementById('apiKeyInputGroup').style.display = 'none';
  document.getElementById('apiKeyCollapsed').style.display = 'flex';
}

function expandApiKey() {
  document.getElementById('apiKeyInputGroup').style.display = '';
  document.getElementById('apiKeyCollapsed').style.display = 'none';
  document.getElementById('apiKey').focus();
}

// 初始化：读取 Key + 恢复上次内容
chrome.storage.sync.get(['deepseekApiKey'], (result) => {
  if (result.deepseekApiKey) {
    document.getElementById('apiKey').value = result.deepseekApiKey;
    collapseApiKey();
  }
});
restoreState();

// 保存 Key
document.getElementById('saveKeyBtn').addEventListener('click', () => {
  const key = document.getElementById('apiKey').value.trim();
  if (key) {
    chrome.storage.sync.set({ deepseekApiKey: key }, () => collapseApiKey());
  }
});

// 修改 Key
document.getElementById('editApiKeyBtn').addEventListener('click', expandApiKey);

// 回车快速保存
document.getElementById('apiKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('saveKeyBtn').click();
});

// ============ 字幕区域折叠 ============
const transcriptSection = document.getElementById('transcriptSection');
const transcriptToggle = document.getElementById('transcriptToggle');

transcriptToggle.addEventListener('click', () => {
  transcriptSection.classList.toggle('collapsed');
});

function showTranscriptSection(text) {
  transcriptSection.style.display = '';
  document.getElementById('transcriptArea').value = text;
  transcriptSection.classList.remove('collapsed');
}

async function getTranscript(videoId) {
  return new Promise((resolve) => {
    chrome.tabs.query({active: true, currentWindow: true}, async (tabs) => {
      const tabId = tabs[0].id;
      const result = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: extractTranscriptFromPage,
        args: [videoId]
      });
      resolve(result[0]?.result || null);
    });
  });
}

function extractTranscriptFromPage(videoId) {
  // 🌐 从页面 HTML 源码提取 ytInitialPlayerResponse（最可靠）
  function extractFromHtmlSource(html) {
    const marker = 'ytInitialPlayerResponse';
    const idx = html.indexOf(marker);
    if (idx === -1) return null;

    // 跳过 "ytInitialPlayerResponse = " 或 "ytInitialPlayerResponse="
    let start = html.indexOf('{', idx);
    if (start === -1) return null;

    // 括号匹配找到 JSON 结尾
    let depth = 0;
    let end = start;
    for (let i = start; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === start) return null;

    try { return JSON.parse(html.substring(start, end)); }
    catch (_) { return null; }
  }

  // 从 playerResponse 提取字幕轨道
  function getCaptionTracks(playerResponse) {
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) return [];
    return tracks;
  }

  // 按语言优先级选最佳轨道：中文 > 英文 > 第一个
  function pickBestTrack(tracks) {
    return tracks.find(t => ['zh', 'zh-Hans', 'zh-CN', 'zh-TW', 'zh-Hant'].includes(t.languageCode))
        || tracks.find(t => t.languageCode === 'en')
        || tracks[0];
  }

  // 解析 XML 字幕为文本
  function parseXmlToText(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const texts = Array.from(doc.getElementsByTagName('text'))
      .map(t => t.textContent.trim())
      .filter(Boolean);
    return texts;
  }

  // 通过 timedtext API 获取字幕（带多重语言回退）
  async function fetchTimedtext(langs) {
    for (const lang of langs) {
      try {
        const resp = await fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}`);
        if (!resp.ok) continue;
        const xml = await resp.text();
        if (!xml || xml.includes('<transcript_list')) continue;
        const texts = parseXmlToText(xml);
        if (texts.length > 5) return texts;
      } catch (_) { /* continue */ }
    }
    return null;
  }

  // ============ 主流程 ============
  return new Promise(async (resolve) => {
    console.log('[YT Summary] 开始多策略字幕提取, videoId:', videoId);

    // ----- 策略 1：从页面 HTML 源码提取 ytInitialPlayerResponse -----
    try {
      console.log('[YT Summary] 策略1: 抓取页面源码...');
      const pageResp = await fetch(window.location.href);
      const html = await pageResp.text();
      const playerResponse = extractFromHtmlSource(html);

      if (playerResponse) {
        const tracks = getCaptionTracks(playerResponse);
        if (tracks.length > 0) {
          const track = pickBestTrack(tracks);
          console.log('[YT Summary] 策略1 找到轨道:', track?.languageCode, track?.name?.simpleText);
          const xml = await fetch(track.baseUrl).then(r => r.text());
          const texts = parseXmlToText(xml);
          if (texts.length > 5) {
            const result = texts.join(' ');
            console.log('[YT Summary] ✅ 策略1 成功, 长度:', result.length);
            resolve(result);
            return;
          }
        }
      }
    } catch (e) {
      console.warn('[YT Summary] 策略1 失败:', e.message);
    }

    // ----- 策略 2：window.ytInitialPlayerResponse（更快，但不一定存在）-----
    try {
      console.log('[YT Summary] 策略2: 尝试 window.ytInitialPlayerResponse...');
      if (window.ytInitialPlayerResponse?.captions) {
        const tracks = getCaptionTracks(window.ytInitialPlayerResponse);
        if (tracks.length > 0) {
          const track = pickBestTrack(tracks);
          console.log('[YT Summary] 策略2 找到轨道:', track?.languageCode);
          const xml = await fetch(track.baseUrl).then(r => r.text());
          const texts = parseXmlToText(xml);
          if (texts.length > 5) {
            const result = texts.join(' ');
            console.log('[YT Summary] ✅ 策略2 成功, 长度:', result.length);
            resolve(result);
            return;
          }
        }
      }
    } catch (e) {
      console.warn('[YT Summary] 策略2 失败:', e.message);
    }

    // ----- 策略 3：直接从 ytplayer.config 或 ytInitialData 中挖掘字幕 -----
    try {
      console.log('[YT Summary] 策略3: 搜索页面中的字幕数据...');
      // ytplayer.config.args 里有时也有 captions 数据
      if (window.ytplayer?.config?.args?.player_response) {
        const pr = JSON.parse(window.ytplayer.config.args.player_response);
        const tracks = getCaptionTracks(pr);
        if (tracks.length > 0) {
          const track = pickBestTrack(tracks);
          const xml = await fetch(track.baseUrl).then(r => r.text());
          const texts = parseXmlToText(xml);
          if (texts.length > 5) {
            const result = texts.join(' ');
            console.log('[YT Summary] ✅ 策略3 成功, 长度:', result.length);
            resolve(result);
            return;
          }
        }
      }
    } catch (e) {
      console.warn('[YT Summary] 策略3 失败:', e.message);
    }

    // ----- 策略 4：timedtext API 直接请求 -----
    console.log('[YT Summary] 策略4: timedtext API...');
    const apiTexts = await fetchTimedtext(['zh', 'zh-Hans', 'zh-CN', 'en']);
    if (apiTexts) {
      const result = apiTexts.join(' ');
      console.log('[YT Summary] ✅ 策略4 成功, 长度:', result.length);
      resolve(result);
      return;
    }

    // ----- 策略 5：Transcript 面板 DOM 提取（最后兜底）-----
    console.log('[YT Summary] 策略5: DOM 面板兜底...');
    try {
      const transcriptBtn = Array.from(document.querySelectorAll('button, [role="button"], tp-yt-paper-item, ytd-menu-service-item-renderer'))
        .find(el => {
          const text = (el.textContent || '').toLowerCase();
          return text.includes('transcript') || text.includes('字幕') || text.includes('显示字幕');
        });
      if (transcriptBtn) transcriptBtn.click();
      await new Promise(r => setTimeout(r, 1500));

      const panelSelectors = [
        'ytd-transcript-segment-renderer .segment-text',
        'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] span',
        '[class*="transcript"] span[class*="segment"]',
        'ytd-transcript-search-panel-renderer yt-formatted-string',
      ];
      for (const sel of panelSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 5) {
          const result = Array.from(els).map(e => e.textContent.trim()).filter(t => t.length > 1).join(' ');
          if (result.length > 100) {
            console.log('[YT Summary] ✅ 策略5 成功, 长度:', result.length);
            resolve(result);
            return;
          }
        }
      }
    } catch (e) {
      console.warn('[YT Summary] 策略5 失败:', e.message);
    }

    console.error('[YT Summary] ❌ 所有策略均失败，无法提取字幕');
    resolve(null);
  });
}

async function summarizeWithDeepSeek(transcript, apiKey) {
  if (!apiKey) {
    const sentences = transcript.split(/[。.!?]/).filter(s => s.length > 8);
    return `【简单提取总结】\n\n${sentences.slice(0, 18).join('。\n')}\n\n请填写 DeepSeek API Key 以获得高质量文章总结。`;
  }

  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",   // 可改为 deepseek-v4-pro
        messages: [
          {
            role: "system",
            content: "你是一位专业的中文内容总结专家。请将提供的 YouTube 视频字幕整理成一篇结构清晰、流畅易读的中文文章，包括：\n1. 标题/引言\n2. 核心要点（分点列出）\n3. 关键洞见或亮点\n4. 总结与启发。"
          },
          {
            role: "user",
            content: `视频字幕内容：\n\n${transcript.substring(0, 14000)}`
          }
        ],
        max_tokens: 1600,
        temperature: 0.7
      })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const data = await response.json();
    return data.choices[0].message.content;
  } catch (e) {
    console.error(e);
    return `DeepSeek API 调用失败: ${e.message}\n\n请检查 API Key 是否正确，以及是否有足够余额。`;
  }
}

// === 按钮事件 ===
document.getElementById('summarizeBtn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  const summaryDiv = document.getElementById('summary');
  const btn = document.getElementById('summarizeBtn');
  
  btn.disabled = true;
  status.textContent = '正在提取字幕...';
  status.className = '';

  try {
    const videoIdRes = await new Promise(r => chrome.runtime.sendMessage({action: "getVideoId"}, r));
    if (videoIdRes.error) throw new Error(videoIdRes.error);

    currentVideoId = videoIdRes.videoId;
    const transcript = await getTranscript(currentVideoId);
    
    if (!transcript || transcript.length < 50) {
      throw new Error('无法获取字幕（视频可能未开启字幕）');
    }

    currentTranscript = transcript;
    showTranscriptSection(
      transcript.substring(0, 8000) + (transcript.length > 8000 ? '\n...（已截断）' : '')
    );

    status.textContent = '正在通过 DeepSeek 生成总结...';
    
    const apiKey = document.getElementById('apiKey').value.trim();
    const summary = await summarizeWithDeepSeek(transcript, apiKey);
    
    summaryDiv.innerHTML = `<h3>📄 视频总结文章</h3><div style="white-space: pre-wrap;">${summary}</div>`;
    status.textContent = '✅ 总结完成！';
    status.className = 'success';
    saveState(summaryDiv.innerHTML);

  } catch (err) {
    status.textContent = `❌ ${err.message}`;
    status.className = 'error';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('showTranscriptBtn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  try {
    const videoIdRes = await new Promise(r => chrome.runtime.sendMessage({action: "getVideoId"}, r));
    if (videoIdRes.error) throw new Error(videoIdRes.error);

    currentVideoId = videoIdRes.videoId;
    const transcript = await getTranscript(currentVideoId);
    if (transcript) {
      currentTranscript = transcript;
      showTranscriptSection(transcript);
      status.textContent = '字幕加载成功';
      status.className = 'success';
      saveState();
    } else {
      throw new Error('该视频没有可用字幕');
    }
  } catch (e) {
    status.textContent = e.message;
    status.className = 'error';
  }
});