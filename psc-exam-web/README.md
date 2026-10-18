# 普通话水平测试（PSC）模拟考试前端

按《普通话水平测试大纲》走完四项机考流程：**本地 TTS 播报考试提示音 → 麦克风录音 → 讯飞 ISE 逐字发音评测（前三项）→ 外部大模型按大纲评分（命题说话）**，并提供讯飞接口与大模型接口的填写页面。

- 纯前端（Vite + React + TypeScript），无需后端；凭据只存本机浏览器 `localStorage`
- 麦克风录音在浏览器内完成，录音只在本机内存/接口调用中流转
- 未配置接口时自动进入**演示模式**，可先跑通全流程

## 快速开始

```bash
cd psc-exam
npm install
npm run dev        # 打开 http://127.0.0.1:5173
```

Windows 下也可以直接双击 `启动.bat`（首次会自动装依赖并打开浏览器）。
生产构建：`npm run build` → 产物在 `dist/`（`npm run preview` 可预览）。

> 麦克风只能在 `https://` 或 `127.0.0.1 / localhost` 下使用，不要用 `file://` 直接打开 `index.html`。

## 接口配置（页面：接口配置）

### 1. 讯飞接口（前三项：单音节 / 多音节 / 朗读短文）

到 [讯飞开放平台控制台](https://console.xfyun.cn/app/myapp) 创建应用，开通 **语音评测（流式版）**（前三项）与 **语音听写（流式版）**（命题说话兜底转写），把同一应用的：

| 字段 | 说明 |
| --- | --- |
| AppID / APIKey / APISecret | 控制台「我的应用」里的三元组 |
| 评测 host / path | 默认 `ise-api.xfyun.cn` + `/v2/open-ise` |
| 语音听写 host / path | 默认 `iat-api.xfyun.cn` + `/v2/iat` |
| 题型 category | `auto` 自动：单音节→`read_syllable`、词语→`read_word`、短文/说话→`read_chapter` |
| 群体 group / 松紧 check_type | 成人为 `adult`；`common` 普通 |
| 拓展能力 extra_ability | 默认 `multi_dimension;syll_phone_err_msg`，需控制台开通全维度权限；留空则不返回维度分 |
| 送评增益 | `0.9` 表示把录音峰值归一到 90%，录音偏小时更准 |

浏览器直接连 `wss://` 完成 HMAC-SHA256 签名，无需后端。点「测试连通性」会用一段合成音验证签名与授权。

### 2. 大模型接口（命题说话）

命题说话没有标准文本、讯飞中文评测不支持自由说，因此该项交给外部大模型按大纲评分。支持：

- **OpenAI 兼容**：`/chat/completions`（OpenAI、DeepSeek、智谱、Moonshot、硅基流动、Ollama、vLLM、LM Studio、one-api 等）
- **Anthropic Messages**：`/v1/messages`（仅文本，需选「先转写再评分」）

| 字段 | 说明 |
| --- | --- |
| Base URL | 到 `/v1` 为止，例如 `https://api.deepseek.com/v1`、`https://api.openai.com/v1` |
| API Key / 模型名称 | 模型需支持音频输入（直传模式），如 `gpt-4o-audio-preview`、`qwen-audio` |
| 命题说话评分方式 | `录音直传`（多模态模型直接听录音）或 `先转写再评分`（文本模型即可） |
| 音频字段风格 | `input_audio`（OpenAI 原生）或 `audio_url`（data URL，兼容更多第三方端点） |
| 转写来源 | 外部 ASR 接口（OpenAI 兼容 `/audio/transcriptions`）或**讯飞语音听写**（复用上面的三元组） |
| 自定义系统提示词 | 留空使用内置的大纲评分细则（推荐） |

> **阿里云百炼 / DashScope 兼容端点**（Base URL 含 `compatible-mode`、`dashscope`、`qianwen` 等）：
> 这类端点只认 `input_audio`，且 `input_audio.data` 必须是 **data URL**（`data:audio/wav;base64,…`）。
> 程序会按地址自动识别并改用该写法；手动传裸 base64 会返回
> `400 The provided URL does not appear to be valid`，传 `audio_url` 会被直接拒绝（它只支持 `text`/`input_audio`/`image_url`/`video_url`/`video`/`file`）。

**浏览器直连注意**：接口必须允许跨域（CORS）。若服务端不允许 CORS，可在本机用 one-api / LiteLLM 之类的网关代理一层，或把页面部署到与接口同域的服务器上。

### 3. 本地 TTS（考试提示音）

- **浏览器内置语音**：完全离线，用 Windows/macOS 自带的本地中文语音（可选语音、语速、音高、音量）。
- **本机 HTTP TTS 服务**：地址里用 `{text}` 占位，例如 `http://127.0.0.1:8080/tts?text={text}`（piper / edge-tts / sherpa-onnx / PaddleSpeech 等），支持 GET 或 POST 请求体模板。
- 提示音包括：考前说明、各项指导语、开始/结束提示音、剩余 60/30/10 秒播报；TTS 故障不会中断考试。

## 考试流程

考前须知 → 设备调试（麦克风试音）→ 逐项作答：

| 分项 | 内容 | 限时 | 分值 | 评分 |
| --- | --- | --- | --- | --- |
| 一 | 读单音节字词 100 个 | 3′30″ | 10 | 讯飞 ISE `read_syllable` |
| 二 | 读多音节词语 100 个音节 | 2′30″ | 20 | 讯飞 ISE `read_word` |
| 三 | 朗读短文 400 音节（`∥` 前） | 4′ | 30 | 讯飞 ISE `read_chapter` |
| 四 | 命题说话（二选一，说满 3 分钟） | 3′ | 40 | 外部大模型按大纲三档评分 |

- 每项：指导语播报 → 准备倒计时 → 录音作答（实时电平条 + 计时）→ 自动/手动停止 → 保存 → 下一项
- 提示音可随时打断：点「继续 / 开始答题 / 进入下一项 / 选题 / 退出」会立刻停掉正在播报的指导语
  （`src/lib/tts.ts` 的 `stopSpeaking()`，内置语音与 HTTP TTS 都支持），不会盖住录音
- 命题说话：先二选一，再准备（默认 30 秒，可改），然后说满 3 分钟
- 全部完成后逐项提交评分，成绩页给出**总分、等级、各分项扣分明细、逐字定位、录音回放**
- 等级按《普通话水平测试等级标准》：97/92/87/80/70/60 分档

## 题库来源

来自工作区附件，已生成到 `src/data/`：

- `works.ts`：50 篇朗读作品（附件 PDF《新普测50篇朗读作品》提取，含 400 音节 `∥` 标记）
- `topics.ts`：50 个命题说话题目（附件 `话题.txt`）
- `chars.ts` / `words.ts`：单音节字与多音节词语（含声母/韵母/声调、轻声/儿化/上声标注），组卷时按大纲要求保证声韵调覆盖、轻声儿化配额、避免同一要素连续

答题页面、组卷逻辑见 `src/lib/draw.ts`。

## 计分口径说明

附件大纲为 5 项 100 分制（含「选择判断」10 分）。大纲「特别说明」允许免测选择判断，此时命题说话由 30 分调为 40 分。本项目采用该 **4 项制**口径，未实现选择判断（附件未提供方言词语/语法差异对照表）。

- 讯飞评测分（0~100）按该项满分折算，并执行大纲的超时扣分、命题说话缺时/不足 30 秒规则
- 扣分明细由引擎的逐字定位（漏读/增读/回读/替换、声母/韵母/调型错误）按大纲单价权重分摊，明细合计与得分一致
- 命题说话：大模型返回 `score/items/comment/issues` JSON，按大纲三档（语音 25 + 词汇语法 10 + 自然流畅 5）扣分

## 目录结构

```
psc-exam/
├── src/
│   ├── App.tsx / main.tsx / styles.css
│   ├── types.ts
│   ├── data/            works.ts topics.ts chars.ts words.ts（题库）
│   ├── lib/
│   │   ├── ise.ts       讯飞 ISE 语音评测（签名 / 分帧 / XML 解析 / 分数折算）
│   │   ├── iat.ts       讯飞语音听写（长录音分片转写，命题说话兜底用）
│   │   ├── speak.ts     命题说话：讯飞听写 + ISE 自参考评测兜底
│   │   ├── llm.ts       外部大模型评分（OpenAI / Anthropic，直传或先转写）
│   │   ├── xfyun.ts     HMAC-SHA256 签名、base64、错误码中文说明
│   │   ├── tts.ts       本地 TTS（内置语音 / HTTP 服务）+ WebAudio 提示音
│   │   ├── recorder.ts  麦克风 PCM 采集 → WAV
│   │   ├── wav.ts       WAV 编解码 / 重采样 / base64
│   │   ├── prompts.ts   考试提示语文案 + 大纲评分细则提示词
│   │   ├── draw.ts      组卷    grade.ts 等级    storage.ts 本地存储
│   ├── pages/           Home Exam Result Bank History Settings
│   └── components/      MonoView PolyView ReadView SpeakView LevelMeter
└── tools/
    ├── mock_server.mjs       本地 Mock（OpenAI 兼容 + 讯飞 ISE/听写 WebSocket + TTS）
    ├── e2e_test.mjs          无头 Edge 端到端测试（支持 E2E_VIEWPORT / E2E_SHOTS）
    ├── mobile_check.mjs      手机视口渲染检查（横向溢出 / 脚本报错 / 截图）
    ├── tts_interrupt_test.mjs 「继续即打断提示音」回归测试（假 speechSynthesis 记录 speak/cancel）
    └── android_debug.mjs     安卓真机调试驱动（通过 adb forward 的 WebView devtools 走 CDP）
```

## 本地联调 & 端到端测试

不接真实凭据时，可用内置 Mock 服务跑通全链路（Mock 实现了 OpenAI 兼容评分、讯飞 ISE 与语音听写的 WebSocket 协议、TTS）：

```bash
npm run mock          # 终端 1：http://127.0.0.1:8100
npm run build && npm run preview   # 终端 2：http://127.0.0.1:4173
npm run e2e           # 终端 3：无头 Edge 跑完四项并校验成绩页

node tools/tts_interrupt_test.mjs  # 提示音「点继续即打断」回归（无需 Mock）
```

E2E 会注入一套指向 Mock 的配置（讯飞 host 写 `127.0.0.1:8100` 时自动用 `ws://`），验证设备调试、四项录音、讯飞评测、大模型评分、成绩页与历史记录，并输出截图 `tools/e2e-result.png`。

## 安卓 APK

已打包为安卓应用，工程在 [`../安卓`](../安卓/README.md)（系统 WebView 壳 +
`WebViewAssetLoader` 以 https 安全源加载本工程构建产物，业务代码无需改动）。

```bat
cd /d ..\安卓
build_apk.bat            :: 前端构建 + 同步资源 + 打 debug/release 包 + 归档到 ..\安卓\out
```

为适配手机屏（360~420px），`src/styles.css` 末尾有一段 `@media (max-width: 600px)`
窄屏规则（顶栏换行、设置页 tab 两列、吸底栏收紧、单音节字表 5 列），桌面端不受影响。
手机视口自测：

```bat
node tools/mobile_check.mjs
set E2E_VIEWPORT=360x800
set E2E_SHOTS=..\安卓\out\screens\e2e-mobile
node tools/e2e_test.mjs
```

## 常见问题

- **提示音没有声音**：确认「考试参数」里 TTS 提示音开启；Windows 需在「设置 → 时间和语言 → 语音」安装中文语音包。
- **麦克风无权限**：检查浏览器地址栏的麦克风授权；必须用 `http://127.0.0.1` 或 https 访问。
- **讯飞报错 10105 / 11200**：控制台未开通对应服务或用量超限；10222 多为网络/超时。
- **大模型 401/404**：注意 Base URL 要带 `/v1`，模型名称要与服务商一致；403 多为跨域被拒（见上文 CORS 说明）。
- **大模型 400 `The provided URL does not appear to be valid`**：多见于阿里云百炼 / DashScope 兼容端点，
  它们的 `input_audio.data` 要 data URL；程序已按地址自动适配，若仍报错请确认 Base URL 含 `compatible-mode`。
- **大模型 400 `Invalid value: audio_url`**：该端点不支持 `audio_url`，请把「音频字段风格」改成 `input_audio`。
- **成绩是 0 或提示失败**：成绩页会显示失败原因（凭据、跨域、超时、录音为空等），可重试或先用演示模式。

> 本系统为模拟练习工具，机器评分结果仅供参考，不代表官方普通话水平测试成绩。
