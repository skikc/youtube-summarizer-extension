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

// ============ 分块与模型选择（v1.3.0 长视频支持）============

function getModel(useDeepMode) {
  return useDeepMode ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
}

function chunkBySize(transcript, maxChars = 4000, overlap = 150) {
  const chunks = [];
  let start = 0;
  while (start < transcript.length) {
    let end = Math.min(start + maxChars, transcript.length);
    // 尝试在句号/换行处断开，避免切断句子
    if (end < transcript.length) {
      const breakChars = ['。', '.', '？', '?', '！', '!', '\n', '；', ';'];
      let bestBreak = -1;
      for (const ch of breakChars) {
        const pos = transcript.lastIndexOf(ch, end);
        if (pos > start + maxChars * 0.6) { bestBreak = Math.max(bestBreak, pos); }
      }
      if (bestBreak > 0) end = bestBreak + 1;
    }
    chunks.push({
      text: transcript.substring(start, end).trim(),
      index: chunks.length,
      title: null
    });
    start = end - overlap;
    if (start >= transcript.length || end === transcript.length) break;
  }
  return chunks.length > 0 ? chunks : null;
}

function chunkByChapters(transcript, chapters, totalDurationSeconds) {
  if (!chapters || chapters.length < 2) return null;
  const totalChars = transcript.length;
  const totalMs = totalDurationSeconds * 1000;
  const chunks = [];

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    const nextChapter = chapters[i + 1];
    const endMs = nextChapter ? nextChapter.startMs : totalMs;

    const startPos = Math.floor((chapter.startMs / totalMs) * totalChars);
    const endPos = nextChapter
      ? Math.floor((endMs / totalMs) * totalChars)
      : totalChars;

    const chunkText = transcript.substring(startPos, endPos).trim();
    if (chunkText.length > 50) {
      chunks.push({
        text: chunkText,
        index: chunks.length,
        title: chapter.title
      });
    }
  }
  return chunks.length > 1 ? chunks : null;
}

function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// 分批并发：每次最多 concurrency 个请求
async function batchParallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, () => worker()));
  return results;
}

async function summarizeChunk(chunkText, chunkIndex, totalChunks, apiKey, chapterTitle) {
  const label = chapterTitle ? `「${chapterTitle}」` : `第 ${chunkIndex + 1}/${totalChunks} 段`;
  try {
    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          {
            role: 'system',
            content: '你是一个视频摘要助手。请提取以下视频片段的关键信息点。用中文输出，每条一行，用"• "开头。只记录事实性内容，不要添加评价。'
          },
          {
            role: 'user',
            content: `这是视频的${label}的字幕内容，请提取关键信息点：\n\n${chunkText.substring(0, 5000)}`
          }
        ],
        max_tokens: 350,
        temperature: 0.3
      })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { index: chunkIndex, label, points: data.choices[0].message.content, error: null };
  } catch (e) {
    return { index: chunkIndex, label, points: '', error: e.name === 'AbortError' ? '请求超时' : e.message };
  }
}

async function mergeChunkSummaries(chunkResults, apiKey, useDeepMode) {
  const validResults = chunkResults.filter(r => !r.error && r.points);
  const failedLabels = chunkResults.filter(r => r.error).map(r => r.label);

  const chunksText = validResults.map(r =>
    `--- ${r.label} ---\n${r.points}`
  ).join('\n\n');

  let mergeNote = '';
  if (failedLabels.length > 0) {
    mergeNote = `\n注意：以下段落提取失败，总结中缺少这些部分的内容：${failedLabels.join('、')}。请在输出中注明。`;
  }

  try {
    const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: getModel(useDeepMode),
        messages: [
          {
            role: 'system',
            content: [
              '请根据以下 YouTube 视频分段摘要，用中文整理为一篇清晰易读的内容摘要。直接输出正文，不要写开场白。每个板块之间用空行分隔。',
              '',
              '输出结构：',
              '【视频概述】',
              '用 2-4 句话简洁概括这个视频的核心内容和观点。',
              '',
              '【核心要点】',
              '用 1. 2. 3. 的序号逐条列出视频中的关键信息、论点。每条要点独立成段，段间空一行。',
              '每条要点先写一句结论性概括，再展开简短说明。忠实于原视频内容，不要添加主观解读。',
              '',
              '【理解与启发】',
              '基于视频内容，提炼出你的整体理解。可以用数字序号分点写。注意：此处是你的总结提炼，并非视频原话，可能存在理解偏差，读者需自行判断。',
              '',
              '写作规则：',
              '1. 不使用 ** ## 等 Markdown 符号，可用纯文字序号 1. 2. 3. 辅助阅读',
              '2. 不写「好的」「以下是总结」「综上所述」等套话',
              '3. 核心要点部分保持视频原意，不添油加醋',
              '4. 一条只说一件事，长内容拆成多条，避免一大段包含多个意思',
              '5. 始终用中文输出，即使原文是英文',
              '6. 这是长视频的分段总结合并，请消除不同段落之间的重复内容，保持时间逻辑顺序',
            ].join('\n')
          },
          {
            role: 'user',
            content: `以下是视频各分段的摘要，请合并为完整总结：\n\n${chunksText}${mergeNote}`
          }
        ],
        max_tokens: 1800,
        temperature: 0.5
      })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.choices[0].message.content;
  } catch (e) {
    throw new Error(`合并总结失败: ${e.message}`);
  }
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

  // 通过 timedtext API 获取字幕（含 ASR 自动生成字幕）
  async function fetchTimedtext(langs) {
    for (const lang of langs) {
      for (const kind of ['', '&kind=asr']) {
        try {
          const resp = await fetch(`https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}${kind}`);
          if (!resp.ok) continue;
          const xml = await resp.text();
          if (!xml || xml.includes('<transcript_list')) continue;
          const texts = parseXmlToText(xml);
          if (texts.length > 5) return texts;
        } catch (_) {}
      }
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

async function summarizeWithDeepSeek(transcript, apiKey, chapters, durationSeconds, useDeepMode, onProgress) {
  if (!apiKey) {
    const sentences = transcript.split(/[。.!?]/).filter(s => s.length > 8);
    return `【简单提取总结】\n\n${sentences.slice(0, 18).join('。\n')}\n\n请填写 DeepSeek API Key 以获得高质量文章总结。`;
  }

  // v1.3.0: 短视频（< 10,000 字符）走单次总结，长视频走分块 map-reduce
  const SHORT_THRESHOLD = 10000;

  if (transcript.length < SHORT_THRESHOLD) {
    // === 短视频：单次总结（保持原有行为） ===
    try {
      const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: getModel(useDeepMode),
          messages: [
            {
              role: "system",
              content: [
                "请根据以下 YouTube 视频字幕，用中文整理为一篇清晰易读的内容摘要。直接输出正文，不要写开场白。每个板块之间用空行分隔。",
                "",
                "输出结构：",
                "【视频概述】",
                "用 2-4 句话简洁概括这个视频的核心内容和观点。",
                "",
                "【核心要点】",
                "用 1. 2. 3. 的序号逐条列出视频中的关键信息、论点。每条要点独立成段，段间空一行。",
                "每条要点先写一句结论性概括，再展开简短说明。忠实于原视频内容，不要添加主观解读。",
                "",
                "【理解与启发】",
                "基于视频内容，提炼出你的整体理解。可以用数字序号分点写。注意：此处是你的总结提炼，并非视频原话，可能存在理解偏差，读者需自行判断。",
                "",
                "写作规则：",
                "1. 不使用 ** ## 等 Markdown 符号，可用纯文字序号 1. 2. 3. 辅助阅读",
                "2. 不写「好的」「以下是总结」「综上所述」等套话",
                "3. 核心要点部分保持视频原意，不添油加醋",
                "4. 一条只说一件事，长内容拆成多条，避免一大段包含多个意思",
                "5. 始终用中文输出，即使字幕是英文",
              ].join('\n')
            },
            {
              role: "user",
              content: `视频字幕内容：\n\n${transcript.substring(0, 30000)}`
            }
          ],
          max_tokens: 2500,
          temperature: 0.5
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

  // === 长视频：分块 Map-Reduce ===
  if (onProgress) onProgress('正在分析视频结构...');

  // Step 1: 分块
  let chunks = null;
  if (chapters && chapters.length > 1 && durationSeconds > 0) {
    chunks = chunkByChapters(transcript, chapters, durationSeconds);
  }
  if (!chunks) {
    chunks = chunkBySize(transcript);
  }

  if (!chunks || chunks.length <= 1) {
    // 分块失败或只有一块，退回单次总结
    if (onProgress) onProgress('分块不足，使用单次总结...');
    return summarizeWithDeepSeek(transcript, apiKey, null, null, useDeepMode);
  }

  // Step 2: Map — 分批并行总结（最多 4 个并发，避免压垮浏览器连接池）
  const totalChunks = chunks.length;
  let completedCount = 0;
  if (onProgress) onProgress(`正在总结 ${totalChunks} 个段落...`);

  const chunkResults = await batchParallel(chunks, 6, async (chunk) => {
    const result = await summarizeChunk(chunk.text, chunk.index, totalChunks, apiKey, chunk.title);
    completedCount++;
    if (onProgress) onProgress(`已完成 ${completedCount}/${totalChunks} 段...`);
    return result;
  });

  // Step 3: Reduce — 合并总结
  if (onProgress) onProgress(`正在合并 ${totalChunks} 段总结...（${useDeepMode ? '深度模式' : '快速模式'}）`);
  return await mergeChunkSummaries(chunkResults, apiKey, useDeepMode);
}

// ============ 将 LLM 纯文本渲染为带层次的可读 HTML ============
function formatSummary(rawText) {
  // 转义 HTML 特殊字符
  let text = rawText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 板块标题映射
  const sections = [
    { marker: /【视频概述】/g, icon: '📺', label: '视频概述', cls: 'overview' },
    { marker: /【核心要点】/g, icon: '📌', label: '核心要点', cls: 'points' },
    { marker: /【理解与启发】/g, icon: '💡', label: '理解与启发', cls: 'insight' },
  ];

  // 将【标题】替换为带样式的 header
  for (const sec of sections) {
    text = text.replace(sec.marker,
      `\n<div class="sum-head sum-head--${sec.cls}">${sec.icon} ${sec.label}</div>\n`);
  }

  // 确保数字序号（1. 2. / 1) 2) / 1、2、）前有空行，独立成段
  text = text.replace(/(^|\n)(\d+[\.\)、]\s*)/g, '$1\n$2');

  // 按空行切块，每块 → <p>
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
  const html = blocks.map(block => {
    block = block.trim();
    // 已经是 header div 就原样保留
    if (/^<div class="sum-head/.test(block)) return block;
    // 普通文本块：单换行 → <br>，包进 <p>
    return '<p>' + block.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');

  return '<div class="sum-body">' + html + '</div>';
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
    const isLongVideo = transcript.length >= 10000;
    showTranscriptSection(
      transcript.substring(0, 8000) + (transcript.length > 8000 ? '\n...（已截断）' : '')
    );

    const useDeepMode = document.getElementById('deepMode')?.checked || false;
    const apiKey = document.getElementById('apiKey').value.trim();

    if (isLongVideo) {
      const chunkCount = Math.ceil(transcript.length / 2500);
      status.textContent = `长视频（${Math.round(transcript.length / 1000)}k 字符），分为 ${chunkCount} 段处理...`;
    } else {
      status.textContent = '正在通过 DeepSeek 生成总结...';
    }

    const summary = await summarizeWithDeepSeek(
      transcript, apiKey, null, null, useDeepMode,
      (msg) => { status.textContent = msg; }
    );

    summaryDiv.innerHTML = formatSummary(summary);
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