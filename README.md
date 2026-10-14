# 视频陪学 AI 助教

实时听课程 → 自动提炼知识点 → 维护结构化笔记 → 生成 Mermaid 知识图谱。

配套**多端捕获助手**：捕获助手只负责「把正在播放的视频音频转成文字并分段流式推给 AI」，AI 助教只负责「接收转写文本、提炼笔记、响应指令」。两端解耦，桌面端 / 浏览器插件 / 网页 / 微信内嵌端都能复用同一套助教核心。

---

## 两种形态，按需选择

| 形态 | 目录 | 适用场景 | 语音转写 |
| --- | --- | --- | --- |
| **桌面客户端**（推荐，主推） | `desktop/` | 独立窗口，像微信一样装着用；**点「开始陪学」就能听整机声音**，B站、网页、微信、本地播放器通吃，不用管是哪个软件在放 | 本地离线 SenseVoice，零成本、不联网 |
| 浏览器插件 | `extension/` | 只想在浏览器里用，不装软件 | 字幕轨 / 麦克风 / 云端 ASR |

### 桌面客户端快速开始

```bash
cd desktop
npm install            # 首次
npm run fetch-asr      # 首次：下载本地语音引擎（约 230 MB，装一次永久可用）
npm start              # 开发模式运行
npm run dist           # 打包成 Windows 安装包（dist/*.exe 双击安装）
```

已经打好安装包的话，直接双击 `desktop/dist/视频陪学AI助教 Setup 0.2.1.exe` 安装即可。

**用法**：打开软件 → 点「开始陪学」→ 窗口会自动缩成一条**置顶悬浮条** → 去 B站 / 微信 / 网页里放视频 → 悬浮条实时显示最新转写和知识点 → 想细看就点悬浮条右上角回到主窗口。

**时间预期**（本地离线转写，i5 低压 4 核实测）：首条转写约 4 秒出现，之后每 10 秒一段；每 15 秒左右出一批知识点。转写本身比实时快 5–10 倍，慢的是每次转写要重新加载模型（约 4 秒），所以分片时长别设太短。

**窗口行为**：点「最小化」或「×」都是**收进系统托盘**，陪学在后台继续，不会退出（右下角双击托盘图标找回窗口；彻底退出用托盘右键「退出」）。想改成点 × 直接退出，在设置页「关闭主窗口时」切换。

### 出问题时先看这三个地方

| 现象 | 先看这里 | 常见原因 |
| --- | --- | --- |
| 一直没文字 | 状态栏的**电平条**动不动 | 不动 = 没收到声音：视频没在放 / 系统静音 / **声音走的是蓝牙耳机**（Windows 回环只抓默认输出设备，切回扬声器） |
| 有文字但没笔记 | 状态栏「提炼」那格 | 显示「本地引擎」= 没填 API Key 或大模型不可用，本地规则引擎也能出笔记，但质量差一截 |
| 程序不见了 | 右下角托盘图标 | 关闭/最小化是收进托盘，不是退出；托盘图标可能被折叠进「隐藏的图标」里 |

需要更细的排查：`VT_SELFTEST_AUDIO=1` 启动会在终端自动跑一遍「开始陪学 → 系统朗读一段中文 → 打印转写与笔记」，用来确认整条链路是否完好。

> ⚠️ **关于「听声音」的原理**：Windows 只允许按「整个屏幕」捕获系统声音（这是系统限制，不是实现偷懒），所以**别戴耳机也能听见**，但反过来——你电脑上任何在响的声音都会被听进去（包括微信提示音）。想只听某个软件，把其他声音关掉即可。
>
> 少数机器（无显卡驱动 / 远程桌面环境）Electron 的 GPU 进程会崩溃，此时设环境变量 `VT_NO_SANDBOX=1` 再启动即可。

### 数据存在哪

设置和陪学记录统一存在 `%APPDATA%\video-tutor\store.json`（开发模式和安装版共用同一个目录），设置页「打开目录」可以直接跳过去。

> 早期版本踩过的坑：渲染界面走的是 `http://127.0.0.1:<随机端口>`，而 `localStorage` 按 origin 隔离，端口一变存储就是空的 —— 表现为「关掉再打开，Key 和记录全没了」。现在配置和记录都落在主进程文件里，与端口无关，重启不丢；陪学被打断时还会把草稿抢救进笔记库。

---

## 一、它能做什么

| 能力 | 说明 |
| --- | --- |
| 流式听课 | 持续接收分段转写文本，自动拼接上下文，过滤重复片段 |
| 知识点提取 | 抓取核心定义、关键结论、公式、考点、对比辨析、易错点 |
| 结构化笔记 | 固定标签：【重点】【易错点】【拓展】，精简短句，不复述原文 |
| 控制指令 | 【暂停】停止增量提取 → 汇总本小节小结 → 待命；收到新文本自动恢复；【课程结束】输出总笔记 + 知识图谱 |
| 知识图谱 | Mermaid 语法，层级固定：主课题 → 一级知识点 → 子要点，支持前端直接渲染 |
| 图谱交互 | 点图谱内任意知识点，展开：定义 / 例子 / 考点 / 关联知识点 |
| 导出 | 一键导出 Markdown 笔记（含 Mermaid 图谱代码块） |

## 二、快速开始（浏览器插件，可选）

1. 打开 Chrome / Edge，地址栏输入 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本仓库的 `extension/` 目录
4. 打开任意视频页（B站、慕课、腾讯课堂…），右下角出现「**陪学**」悬浮按钮，点击即可开始
5. 侧边栏会实时显示转写文本与笔记，随时可「暂停 / 小结」「课程结束」

不装插件也能体验：直接用浏览器打开 `demo/index.html`（需通过本地 http 服务访问，见下文「网页端 demo」）。

## 三、四条转写通道（按可靠性排序）

| 通道 | 成本 | 说明 |
| --- | --- | --- |
| **字幕捕获** | 0 | 直接读页面视频的字幕轨（`<track>`），最准。含字幕轨的站点自动启用 |
| **手动粘贴 / 导入** | 0 | 粘贴讲稿或导入 `.txt/.srt/.vtt`，100% 可用，适合先跑通流程 |
| **麦克风语音识别** | 0 | 浏览器内置 Speech Recognition，实时流式。注意：Chrome 内置识别依赖 Google 服务，国内网络可能不可用，会自动报错提示 |
| **页面音频 + 云端 ASR** | 需额度 | `chrome.tabCapture` 抓页面音频 → 分段编码 WAV → 调用 `/v1/audio/transcriptions`。精度最高、不受环境音干扰 |

默认策略：**自动（字幕优先）**，抓不到字幕时回退麦克风识别。

## 四、两种提炼引擎

- **大模型引擎**（推荐）：任意 OpenAI 兼容接口。默认 ModelScope 魔搭，模型 `Qwen/Qwen3.8-Flash-Next`。提炼质量明显更好。
- **本地规则引擎**（零成本兜底）：无 Key、无网络、余额不足时自动接管。靠触发词识别定义 / 结论 / 公式 / 考点 / 辨析 / 易错点，并自动剥掉「考点来了：」「再拓展一下，」这类口播套话。

> 遇到 `402 balance is insufficient` 时，助教会自动停用大模型、切到本地引擎并提示，不会反复重试烧额度。充值后刷新页面即恢复。

### ⚠ 关于「免费额度」的实测结论（2026-10）

**硅基流动**：新用户送 2000 万 token，用尽后返回 `402`。实测发现**账户余额耗尽时，整个账户下所有模型都会被拒——包括官方标注为「免费」的模型**（`THUDM/GLM-4-9B-0414`、`Qwen/Qwen3-ASR-1.7B` 等同样 402）。也就是说，免费模型并不能绕过余额校验。

**ModelScope 魔搭**：Key 以 `ms-` 开头，接口 `https://api-inference.modelscope.cn/v1`，每天有免费调用额度，模型很新（Qwen3.8 / GLM-4.7 / DeepSeek-V4）。
⚠ **新账户必须先完成邮箱验证**才能调用，否则所有模型都返回：

```
For account security, please complete your profile via email verification.
ModelScope Magicubes is only available to verified accounts.
```

→ 去 <https://modelscope.cn/my/settings/account> 完成验证（约 1 分钟），之后即可正常调用。这不是额度问题，是风控。

**零成本备选 → 智谱 AI**：`glm-4-flash` 属于「永久免费、不限 token」型（仅 30 并发限制），中文能力强、国内直连，适合本项目这种高频小请求场景。
开通步骤：注册 <https://open.bigmodel.cn> → 控制台创建 API Key → 在扩展设置页把「服务商预设」切成**智谱 AI**，粘贴 Key，点「测试连接」。

## 十二、服务商预设

设置页内置一键切换，无需手填地址：

| 预设 | Base URL | 默认模型 | 成本 |
| --- | --- | --- | --- |
| **ModelScope 魔搭** ★ | `https://api-inference.modelscope.cn/v1` | `Qwen/Qwen3.8-Flash-Next` | 每日免费额度（需先完成邮箱验证） |
| **智谱 AI** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | 永久免费，不限 token |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `Qwen/Qwen3-8B` | 送 2000 万 token，之后按量 |
| 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-flash` | 新用户大额免费额度 |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 按量付费，单价低 |
| OpenRouter | `https://openrouter.ai/api/v1` | `deepseek/deepseek-chat-v3.1:free` | `:free` 模型免费 |

自定义地址需在设置页点「授权访问该域名」，否则扩展无法发起请求。

### 命令行诊断（换 Key / 换服务商时先跑这个）

```bash
node tools/checkkey.mjs --key ms-xxxxxxxx        # 自动按前缀识别服务商
node tools/checkkey.mjs --provider zhipu --key xxx
node tools/checkkey.mjs --list                   # 列出该账号可用模型
```

会直接告诉你失败原因（未验证 / 余额不足 / Key 无效 / 模型名错误 / 跨域），不用去翻浏览器控制台。

## 五、桌面端的语音转写（本地离线）

不需要任何 API、不联网、不花钱、没有额度限制。

- 引擎：[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) `sherpa-onnx-offline.exe`（Windows x64，22 MB）
- 模型：**SenseVoiceSmall int8**（约 226 MB，中/英/日/韩/粤，自带语种识别 + 标点 + 数字规整）
- 实测性能（i5-11 代低压 4 核）：20 秒音频解码 **1.5–2.2 秒**（约 10 倍实时）
- 分片策略：每 20 秒音频转写一次，**2 路并发 worker** 摊掉进程启动开销；静音片段直接丢弃，不浪费算力
- 一句话：买断制，装完永久能用。

模型与引擎体积大，所以不随仓库走，用 `node tools/fetch-asr.mjs` 一键下载（GitHub 直连不稳时自动走 hf-mirror 国内镜像）。

## 六、目录结构

```
desktop/                        ★ 桌面客户端（Electron，主推形态）
├── package.json                运行 / 打包脚本；electron-builder 配置
├── devkey.json                 自带 API Key（已 gitignore；打包会带一份进安装目录，分享给别人前先删）
├── resources/
│   ├── icon.ico / icon.png     应用图标（多尺寸，托盘也用）
│   └── asr/                    本地语音引擎（fetch-asr 下载，已 gitignore）
│       ├── sherpa-onnx-*/bin/sherpa-onnx-offline.exe
│       └── sensevoice/model.int8.onnx + tokens.txt
├── update.json                 自动更新的默认源（owner / repo / 自定义清单地址）
└── src/
    ├── main/
    │   ├── main.js             主进程：静态服务、窗口/托盘、音源、转写 worker 池、文件存储
    │   ├── updater.js          自动更新：拉清单 → 比版本 → 下载校验 → 调安装包覆盖安装
    │   └── preload.js          白名单 IPC 桥
    └── renderer/
        ├── index.html/.css/.js 主窗口（三栏客户端界面）
        ├── pcm-tap.js          AudioWorklet：把系统音频块抛回主线程
        ├── float.html/.js      置顶悬浮条
        └── core/               由 tools/sync-core.mjs 从 extension 同步，勿手改

extension/                      浏览器插件（Chrome MV3，可选形态）
├── manifest.json
├── assets/                     图标
├── vendor/mermaid.min.js       图谱渲染库（本地打包，不依赖 CDN）
└── src/
    ├── core/                   ★ 平台无关的核心（桌面端 / 网页 / 微信端复用）
    │   ├── config.js           配置（优先级：设置页 > config.local.js > 默认值）
    │   ├── protocol.js         捕获助手 ↔ 助教 消息协议
    │   ├── tutor.js            助教状态机（流式拼接、去重、指令、图谱）
    │   ├── llm.js              OpenAI 兼容客户端（chat + audio/transcriptions）
    │   ├── localEngine.js      本地规则引擎（零成本兜底）
    │   ├── knowledgeGraph.js   Mermaid 生成 + Markdown 导出
    │   ├── prompts.js          提示词
    │   └── similarity.js       中文 bigram 去重
    ├── background/             后台编排：会话调度、转写通道、存档
    ├── offscreen/              标签页音频捕获 → 分段 WAV 编码
    ├── content/                页面悬浮按钮 + 字幕轨捕获
    ├── sidepanel/              陪学主界面（笔记 / 图谱 / 控制）
    └── options/                设置页

demo/index.html                 网页端 demo（不装任何东西也能跑）
tools/
├── sync-core.mjs               把助教核心同步到桌面端
├── fetch-asr.mjs               下载装配本地语音引擎
├── checkkey.mjs                命令行 API Key 诊断
└── selftest.mjs                核心引擎端到端自测
```

**核心只有一份**：`extension/src/core/` 是唯一真源，桌面端通过 `npm run sync-core` 同步过去。改核心只改 `extension/src/core/`，两个形态同时受益。

## 七、消息协议

捕获助手 → 助教，只需三种消息：

```js
// 1) 分段流式转写文本
{ type:'segment', sessionId, seq, text:'…', tStart, tEnd }

// 2) 控制指令
{ type:'command', cmd:'pause' | 'resume' | 'end' | 'summary_now' }

// 3) 知识点查询
{ type:'query', topic:'三次握手' }
```

助教 → 前端，通过事件广播：`transcript` / `notes` / `section` / `graph` / `topic` / `state` / `error`。

只要按这个协议推送文本，任何一端（Electron 桌面悬浮端、微信内置浏览器、移动 App）都能直接接入现有助教核心，无需改动 `core/`。

## 七、配置

- **桌面端**：设置页填写（存 localStorage）。开发模式还会读 `desktop/devkey.json`（已 gitignore，**不会被打进安装包**）。
- **插件**：设置页填写，或写在 `extension/src/core/config.local.js`（已 gitignore）。

> ⚠️ 推到公开仓库前，确认 `config.local.js` / `devkey.json` 都没有被提交。录屏推广时也别把设置页里的 Key 露出来。

## 八、网页端 demo

ES module 需要 http 协议，不能直接双击打开：

```bash
python -m http.server 8765
# 浏览器打开 http://127.0.0.1:8765/demo/index.html
```

点「示例文本」→「开始陪学」→「推送」→「课程结束」，即可看到完整链路。

## 九、自测

```bash
node tools/selftest.mjs          # 走大模型（有 Key 时）
node tools/selftest.mjs --local  # 强制本地规则引擎
node tools/checkkey.mjs --key ms-xxx   # 诊断 API Key（按前缀自动识别服务商）

# 桌面端整机链路自检：自动开始陪学 → 系统朗读一段中文 → 打印转写与笔记
cd desktop && VT_SELFTEST_AUDIO=1 ./node_modules/.bin/electron . --no-sandbox
```

排查用的其它开关（main.js 里实现）：`VT_DEBUG=1` 往 `<userData>/launch.log` 写启动日志；`VT_SHOT=1` 截主窗口到 `<userData>/shot.png`，可配 `VT_SHOT_VIEW=settings`、`VT_SHOT_CLICK=#btnSaveCfg` 控制截图前的操作。

## 十、自动更新

应用内置了自动更新，**不用手动卸载旧版**：有新版本时顶部会弹出一条公告（版本号 + 更新说明），
点「立即更新」就会自动下载安装包、静默覆盖安装、装完自动打开新版。笔记和配置都在
`userData` 里，更新不会丢。也可以「稍后」或「忽略这个版本」。

更新器是自己实现的（`desktop/src/main/updater.js`），没用 electron-updater —— 后者在
Windows 上依赖代码签名，且只认 GitHub 的固定布局，不方便换源换镜像。

**发一版的流程**

```bash
cd desktop
# 1) 改 package.json 里的 version，然后打包
npm run dist
# 2) 生成更新清单 latest.json（会自动算 size 和 sha512）
npm run latest -- --notes "这版改了什么"
# 3) 把安装包 + latest.json 传到 GitHub Release，并把 latest.json 推到 main 分支
```

**客户端怎么找更新**：默认读 `desktop/update.json` 里的 `owner/repo`，去取该仓库 main 分支下的
`latest.json`（优先走 jsDelivr，国内可直连；失败再走 raw + 镜像）。也可以换源：改随包的
`desktop/update.json`，或在数据文件里设 `vt_update_cfg.feedUrl` 指向任意静态地址，会优先用它。

下载地址会依次尝试：原链接 → ghfast → gh-proxy → ghproxy 镜像，下完按 sha512 校验，
不一致就自动换下一个源重试。

坑记一条：**安装前必须先让旧进程退出**。旧版正跑着（尤其是收在托盘里）时，安装程序会一直
等它关闭、卡住不动。所以更新器的做法是：安排一个 3 秒后启动安装包的 detached 命令，
本进程立刻退出，让出位置。

## 十一、后续规划

- [x] ~~桌面客户端（Electron）：全局捕获系统音频，不再依赖浏览器~~（已完成）
- [x] ~~配置与记录持久化、系统托盘、悬浮条自动弹出~~（已完成）
- [x] ~~自动更新：公告 → 一键下载覆盖安装，不用手动卸载~~（已完成）
- [x] ~~暂停后能继续听课、更新公告条不再常驻、更新前自动保存草稿~~（0.3.2）
- [ ] **降低转写延迟**：目前每次转写都要重新加载模型（约 4 秒）。改用 `sherpa-onnx-node` 在主进程常驻模型，可把延迟压到 1 秒内，是当前体感提升最大的一项
- [ ] 单应用音频捕获：目前只能听整机声音，想只抓某个软件需要走 Windows 进程级 loopback
- [ ] 笔记 ↔ 时间点跳转（点笔记回看视频那一段）
- [ ] 微信 / 移动端内嵌页接入
- [ ] 笔记双链与复习卡片（Anki 导出）
- [ ] 首次启动引导（自动检测引擎是否就绪、一键下载）
