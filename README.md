# YT Summary — YouTube 视频智能总结

一键提取 YouTube 视频字幕，通过 DeepSeek 大模型生成**结构化的中文文章总结**。Chrome 浏览器扩展，即装即用。

## ✨ 功能

- 🎯 **一键总结** — 在 YouTube 视频页面点击扩展图标，自动提取字幕并生成文章式总结
- 🧠 **DeepSeek 驱动** — 使用 DeepSeek V4 大模型，生成标题、核心要点、关键洞见和总结启发
- 🔍 **5 层递进字幕提取** — 多重策略确保绝大部分视频都能抓到字幕：
  1. 页面 HTML 源码提取 `ytInitialPlayerResponse`
  2. `window.ytInitialPlayerResponse` 直接读取
  3. `ytplayer.config.args` 备用通道
  4. YouTube Timedtext API 直接请求
  5. Transcript 面板 DOM 提取兜底
- 💾 **内容持久化** — popup 关闭再打开，之前的字幕和总结自动恢复
- 🔐 **API Key 安全** — Key 仅保存在浏览器本地存储，折叠收纳不占视野
- 📍 **页面浮动按钮** — YouTube 播放页右下角自动注入「📝 总结视频」按钮

## 📸 预览

![screenshot](screenshot.png)

## 🚀 安装

### 方式一：开发者模式加载（推荐）

1. 克隆或下载本仓库
   ```bash
   git clone https://github.com/skikc/youtube-summarizer-extension.git
   ```
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启右上角 **「开发者模式」**
4. 点击 **「加载已解压的扩展程序」**
5. 选择项目文件夹 `youtube-summarizer-extension/`
6. 完成 ✅

### 方式二：打包安装

1. 在 `chrome://extensions/` 页面点击 **「打包扩展程序」**
2. 选择项目文件夹，生成 `.crx` 文件
3. 拖入 `.crx` 到扩展页面安装

## 🔑 配置 API Key

1. 前往 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 注册并获取 API Key
2. 打开任意 YouTube 视频页面，点击扩展图标
3. 在弹出框中填入 API Key，点击 **保存**
4. Key 保存在本地浏览器中，不会上传到任何第三方服务器

> 💡 DeepSeek 目前注册即送免费额度，足够日常使用。

## 🧩 项目结构

```
youtube-summarizer-extension/
├── manifest.json      # Chrome 扩展配置 (Manifest V3)
├── popup.html         # 弹出框界面
├── popup.css          # 弹出框样式
├── popup.js           # 核心逻辑：字幕提取 + 总结生成 + 持久化
├── background.js      # Service Worker：处理消息通信
├── content.js         # 内容脚本：注入页面浮动按钮
└── icon.svg           # 扩展图标
```

## 🛠 技术栈

- **Manifest V3** — Chrome Extension 最新规范
- **Chrome Scripting API** — 在页面上下文执行字幕提取脚本
- **chrome.storage** — 本地持久化字幕和总结内容
- **DeepSeek API** (`deepseek-v4-flash`) — 高质量中文文本总结
- **5 层递进提取策略** — 括号匹配 JSON 解析 + DOM 爬虫 + API 回退

## 📝 使用说明

1. 打开 YouTube 视频页面（`youtube.com/watch?v=...`）
2. 点击浏览器工具栏的扩展图标（或右下角浮动按钮）
3. 点击 **「总结当前视频」**
4. 等待提取和生成（约 5-15 秒）
5. 查看生成的总结文章
6. 如需查看原始字幕，点击 **「显示完整字幕」**

## 🔄 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.1.0 | 2026-06-10 | 5 层递进字幕提取、内容持久化回显、API Key 折叠收纳 |
| v1.0.0 | - | 初始版本：基础字幕提取 + DeepSeek 总结 |

## 📄 License

MIT
