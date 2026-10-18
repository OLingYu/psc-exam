# 普通话模拟考试 · 安卓版

把 `D:\工作区\普通话\psc-exam`（Vite + React + TypeScript 前端）打包成 Android 应用的独立 Gradle 工程。
前端源码不在本目录修改：构建产物 `dist/` 同步到 `app/src/main/assets`，由系统 WebView 加载。

**已产出可安装 APK：**

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `out/psc-exam-1.0.0-release.apk` | 1.08 MB | 正式版，已签名，**推荐装机用这个** |
| `out/psc-exam-1.0.0-debug.apk` | 1.53 MB | 调试版，支持 `chrome://inspect` 远程调试 |

SHA256（本次交付产物校验值，用于核对文件完整性）：

```
psc-exam-1.0.0-release.apk  a9c350f8319403597c85a25c24973008523a55824a7afd38e1b290d89c821dac
psc-exam-1.0.0-debug.apk    ff2d753180ab995459c6c7d06340de4606a4054fa53cce5fcb737add48f55530
```

包名 `com.psc.exam`，版本 1.0.0（versionCode 1），minSdk 24（Android 7.0），targetSdk 34。

**已在真机验证通过**：魅族 20 Pro（Android 16 / 系统 WebView 149）安装后可正常录音答题、播报提示音，
四项考试可完整走完到成绩页。

## 构建

### 一键构建（推荐）

```bat
cd /d D:\工作区\普通话\安卓
build_apk.bat
```

`build_apk.bat` → `build_apk.ps1`，依次完成：前端 `npm run build` → 同步 `dist` 到
`app/src/main/assets` → `gradlew assembleDebug assembleRelease` → APK 归档到 `out\` 并打印 SHA256。

`build_apk.ps1` 的开关：

| 参数 | 作用 |
| --- | --- |
| `-Variant both\|debug\|release` | 打哪种包，默认 `both` |
| `-SkipWeb` | 不动前端，只重新打包（改过 Kotlin/清单/资源时用） |
| `-WebOnly` | 只构建前端并同步资源（`build_web.bat` 就是它的包装） |
| `-JdkHome` / `-AndroidSdk` | 显式指定 JDK / Android SDK |

脚本会按 `-JdkHome` → `JAVA_HOME` → 本机工具链目录 的顺序找 JDK，按 `-AndroidSdk` →
`ANDROID_HOME` → `local.properties` 的顺序找 SDK，找不到会直接报错退出。

### Android Studio

直接打开本目录，Run / Build APK 即可（`local.properties` 已指向本机 SDK）。

### 手工命令行

```bat
set JAVA_HOME=C:\Users\<user>\AppData\Local\psc-android-toolchain\jdkx\jdk-17.0.20.1+1
set ANDROID_HOME=C:\Users\<user>\AppData\Local\psc-android-toolchain\android-sdk
gradlew.bat assembleRelease
:: 产物：app\build\outputs\apk\release\app-release.apk
```

### 环境要求

JDK 17、Android SDK（Platform 34 + Build-Tools 34.0.0）、Node.js 18+（构建前端）。
本机已就绪的工具链在 `%LOCALAPPDATA%\psc-android-toolchain`（JDK 17 + Android SDK + Gradle 8.7），
`gradle\wrapper\gradle-wrapper.properties` 的 `distributionUrl` 指向腾讯镜像，国内可直接下载。

> 打包不需要 Android 模拟器。本机原先装过模拟器 + Android 34 系统镜像，已整体移到
> `D:\develop\android-emulator`（`emulator\`、`system-images\`），以腾出 C 盘空间；
> 要再用模拟器可把它们移回 `...\android-sdk\`（sdkmanager 才会重新识别），或重新安装。
> 真机调试用 `adb`（`platform-tools` 仍在 SDK 内）即可。

## 目录结构

```
安卓/
├─ build_apk.ps1 / build_apk.bat   一键构建（前端 + Gradle + 归档 out\）
├─ build_web.bat                   只重建前端并同步资源（包 build_apk.ps1 -WebOnly）
├─ keystore/psc-exam-release.jks   release 自签名密钥（配合 keystore.properties）
├─ out/                            构建产物：APK + screens/（手机视口截图与检查报告）
├─ gradlew / gradlew.bat           Gradle Wrapper（distributionUrl 走腾讯镜像）
├─ settings.gradle.kts / build.gradle.kts / gradle.properties
└─ app/
   ├─ build.gradle.kts             AGP 8.5.2 · Kotlin 2.0.21 · compileSdk 34 · minSdk 24 · 签名配置
   └─ src/main/
      ├─ AndroidManifest.xml       权限 / Activity / 允许明文流量
      ├─ java/com/psc/exam/
      │   ├─ MainActivity.kt       WebView 装载、WebViewAssetLoader、权限、下载、外链、常亮
      │   └─ TtsBridge.kt          系统 TTS 桥（window.speechSynthesis 垫片）+ 导出文件落盘
      ├─ assets/
      │   ├─ index.html            前端构建产物（assets 根，见下文「资源映射」）
      │   ├─ assets/*.js, *.css    Vite 产物
      │   └─ tts-shim.js           speechSynthesis 垫片（运行时注入，构建脚本会保留它）
      └─ res/                      图标 / 文案 / 主题
```

## 实现要点

| 项 | 方案 |
| --- | --- |
| 容器 | 系统 WebView + `WebViewAssetLoader`，以 `https://appassets.androidplatform.net/` 安全源加载本地资源 |
| 为什么必须是 https | `getUserMedia`（麦克风）、`crypto.subtle`（讯飞 HMAC 签名）、localStorage、`wss://` 都要求安全上下文；用 https 源后 **web 业务代码零改动**，绝对路径 `/assets/*` 也与浏览器一致 |
| 资源映射 | `WebViewAssetLoader.Builder().addPathHandler("/", AssetsPathHandler(context))`，对应 web 产物放在 `assets/` 根（androidx.webkit 1.11 只有 `addPathHandler` + 单参 `AssetsPathHandler`，没有 `addMapping`，也不支持映射到子目录） |
| 录音权限 | 清单声明 **`RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`** 两条（缺后者录音设备列表为空，见下节）+ 启动时运行时申请；`WebChromeClient.onPermissionRequest` 把授权结果转给网页 |
| 考试提示音 | Android WebView 没有可靠的 `window.speechSynthesis`，内置 `assets/tts-shim.js` + `TextToSpeech` 桥实现等价接口（依赖设备中文 TTS 语音包）；设置页也可改用 HTTP TTS |
| 提示音可中断 | 考试里点「继续 / 开始答题 / 进入下一项 / 选题 / 退出」会立刻掐断正在播报的指导语（`stopSpeaking()`：内置语音 cancel + HTTP 音频 pause + 丢弃排队句子），不会盖住录音、也不用等它念完 |
| 导出配置 | `blob:` 下载由 `DownloadListener` 取回、经 JS 读成 base64 后由 `TtsBridge` 存到「下载」目录（Android 10 以下为应用专属目录） |
| 外部链接 | 讯飞控制台等 `http(s)` 外链跳系统浏览器 |
| 其他 | 考试中屏幕常亮；横竖屏切换不重建页面（`configChanges`）；返回键走 WebView 历史；只有 debug 包允许 `chrome://inspect` |

## 真机踩坑：麦克风必须声明 MODIFY_AUDIO_SETTINGS

真机（魅族 20 Pro / Android 16 / WebView 149）上，即使应用已获得麦克风权限、系统中也没有别的应用占用，
网页 `getUserMedia` 仍然失败，页面显示 **`NotReadableError: Could not start audio source`**。
抓 logcat 后定位到 Chromium 音频层的要求：

```
W cr_media: Requires MODIFY_AUDIO_SETTINGS and RECORD_AUDIO. No audio device will be available for recording
E chromium: [ERROR:media/audio/android/audio_manager_android.cc:877] Unable to select communication device!
```

即 WebView 的 `cr_media` 需要**同时**具备 `RECORD_AUDIO` 和 `MODIFY_AUDIO_SETTINGS` 才会把录音设备暴露给页面；
只声明前者时设备列表为空 → 选不到设备 → `NotReadableError`。补齐 `MODIFY_AUDIO_SETTINGS`
（普通权限，安装时自动授予、无需运行时申请）后，同一台机器上「检测麦克风」立刻从报错变成「默认麦克风」（绿色），
四项录音与评分全流程通过。桌面 Chrome 不会报这个错，所以只在真机上才暴露。

## 手机适配（本次改动）

桌面 1180px 布局直接塞进 360~420px 手机屏会出问题，`psc-exam/src/styles.css` 末尾新增了一个
`@media (max-width: 600px)` 块（只加窄屏规则，桌面端表现不变）：

- **顶栏**：窄屏换行成「品牌一行 + 导航一行」，字号收紧，不再把品牌文字压成两行。
- **设置页 tab**：4 个 tab 一行一个会把面板顶到吸底保存栏下面（实测会挡住「测试对话接口」按钮，点不到）。
  改为两列网格。
- **吸底保存栏**：收成单行并隐藏长提示文案，避免长期遮挡内容。
- **单音节 100 字表**：桌面 10 列在 360px 下横向溢出（右侧被裁），改 5 列并缩小字号；多音节词改固定两列。
- **留白与表格**：主区/面板内边距、表格字号在窄屏收紧；提示条上移避开吸底栏与系统手势区。

另外按需求新增了**「继续」即中断提示音**：`psc-exam/src/lib/tts.ts` 里补了真正的取消能力
（`generation` 代际 + 取消回调：内置语音 `speechSynthesis.cancel()`、HTTP TTS 音频 `pause()` + 丢弃排队句子），
`Exam.tsx` 在「开始设备调试 / 跳过调试 / 设备正常进入考试 / 开始答题 / 停止录音 / 重录 / 进入下一项 /
选题 / 准备好了立即开始 / 退出」这些按钮上先调 `stopSpeaking()` 再进入下一阶段，离开考试页也会掐断。

配套的可重复验证工具（在 `psc-exam/tools/`）：

- `mobile_check.mjs`：无头 Edge 在 360×800 / 412×915 视口加载构建产物，检查横向溢出、脚本报错、
  可点尺寸，输出各页截图与 `mobile-check.json` 到 `安卓/out/screens/`。
- `e2e_test.mjs` 新增 `E2E_VIEWPORT=360x800`（手机视口）与 `E2E_SHOTS=<目录>`（逐步截图），
  并在四项作答与成绩页加了「横向溢出即失败」断言。

## 真机调试

手机上装 **debug 包**（`out/psc-exam-1.0.0-debug.apk`；release 包关闭了 WebView 调试），然后：

```bat
adb devices
adb shell am start -n com.psc.exam/.MainActivity
adb shell pidof com.psc.exam
:: 用上面输出的 pid 转发 WebView 调试端口
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
```

- 桌面浏览器打开 `chrome://inspect` 即可直接调试页面；`http://127.0.0.1:9222/json` 可看到 target 列表。
- 仓库带了自动化驱动 `psc-exam/tools/android_debug.mjs`：连 CDP 自动跑 首页 → 设备调试 → 四项 → 成绩页 → 题库/历史/设置，
  收集 console 报错、JS 异常、HTTP 4xx/5xx 与请求失败，并逐步截图：
  `node ..\psc-exam\tools\android_debug.mjs`
- 常用 logcat：`adb logcat -s PscExam:* PscTts:* cr_media:* chromium:*`

真机实测（魅族 20 Pro / Android 16 / WebView 149）结论：

- 麦克风、录音（2~3 秒短录音）、提示音、四项流程、成绩页、各页面导航均正常；
- 命题说话走真实大模型端点时曾报 `HTTP 400 The provided URL does not appear to be valid`：百炼/DashScope 兼容端点
  要求 `input_audio.data` 为 data URL、且不支持 `audio_url`；已在 `llm.ts` 按端点自动适配，修复后该项正常返回评语；
- 系统语音里有 zh-CN 与 zh-TW 两种中文语音，首页「提示音 TTS」已改为优先显示/使用 zh-CN；
- `favicon.ico` 404、`ScriptProcessorNode` 弃用提示属噪声，不影响功能。

## 签名与升级

`app/build.gradle.kts` 从工程根的 `keystore.properties` 读取 release 签名配置；文件不存在时
release 产物为未签名（`app-release-unsigned.apk`），debug 不受影响。

- 密钥：`keystore/psc-exam-release.jks`（自签名 RSA 2048，有效期 10000 天，alias `psc`）
- 口令：见 `keystore.properties`（`keystore.properties`、`*.jks`、`out/` 已在 `.gitignore` 中忽略）
- 签名方案：v2（minSdk 24 起 AGP 不再生成 v1），`apksigner verify` 通过
- **升级安装必须复用同一 keystore 与口令**，否则系统会以「签名不一致」拒绝覆盖安装，需要先卸载旧版
- 自签名证书只适合本机/侧载分发；要上应用商店需换成正式签名与备案

## 验证记录（本机实测）

| 项目 | 结果 |
| --- | --- |
| `gradlew assembleDebug` / `assembleRelease` | BUILD SUCCESSFUL |
| `aapt2 dump badging` | 包名/版本/minSdk 24/targetSdk 34/权限（INTERNET、ACCESS_NETWORK_STATE、RECORD_AUDIO、MODIFY_AUDIO_SETTINGS）/启动 Activity 均正确 |
| `apksigner verify` | release：v2 签名有效，签名者 `CN=PSC Exam, O=Local Build`（证书 SHA-256 `43506171…cf98fb5`） |
| APK 内资源 | `assets/index.html` 与 `psc-exam/dist/index.html` 逐字节一致；`assets/assets/index-CK-Ammmi.js`（454,952 B）、`index-C83Rqvyg.css`（18,125 B）、`tts-shim.js` 齐全 |
| 桌面视口 e2e（Mock 讯飞 ISE + 大模型 + 假麦克风） | 12 项断言通过：设备调试 → 四项录音 → ISE 评测 → 大模型评分 → 成绩页 → 历史记录 |
| 手机视口 e2e（360×800，同上流程 + 溢出断言） | 12 项断言通过 |
| `mobile_check.mjs` 360×800 / 412×915 | 首页/题库/设置/历史：横向溢出 0，脚本报错 0 |
| **真机安装 + 人工点测** | 魅族 20 Pro（Android 16 / WebView 149）：麦克风检测正常、四项录音、提示音播报与「继续」中断、成绩页全部通过 |
| 手机截图 | `out/screens/`（`360x800-*.png`、`412x915-*.png`、`e2e-mobile/exam-*.png`） |

e2e 用的是本地 Mock 服务（`npm run mock`）与无头 Edge，不消耗真实讯飞/大模型额度；
布局与 JS 兼容性结论与 Android WebView 一致（同为 Chromium），原生能力以真机点测为准。

## 使用说明

1. 首次启动会申请**麦克风**权限，拒绝后无法录音答题（可到系统设置里重新授权）。
   麦克风还需要清单里的 `MODIFY_AUDIO_SETTINGS`（普通权限，安装即授予）—— 这是 WebView 录音的硬要求。
2. 接口配置与网页版完全一致：页面「接口配置」里填讯飞三元组 / 大模型 Key / TTS 地址，数据存本机
   WebView `localStorage`（`https://appassets.androidplatform.net` 源），与电脑浏览器互不相通。
3. 提示音默认「内置语音」= 设备系统 TTS；设备无中文语音包时，请在设置里改用 HTTP TTS 或关闭提示音
   （提示音故障不会中断考试）。
4. 讯飞 ISE/听写为 `wss://` 直连；大模型接口为页面直接 `fetch`，跨域要求与网页版相同（需允许 CORS，
   Origin 为 `https://appassets.androidplatform.net`）。
5. 本机 HTTP TTS 可填局域网地址（如 `http://192.168.x.x:8080/tts?text={text}`），手机与服务需同一网络。

## 已知限制

- Android 7 且 WebView 未更新的老设备（Chrome < 74 一类的旧内核）可能不支持构建产物用到的
  较新 JS 语法；建议系统 WebView 保持更新（Google Play 会自动更新）。
- 提示音依赖设备的系统 TTS 中文语音包。真机（魅族 20 Pro）上系统只提供 `zh-TW` 语音，
  首页会显示「浏览器内置（zh-TW-language）」；要更标准的普通话播报，建议在系统「设置 → 语音合成」
  里装一个中文（普通话）语音包，或改用 HTTP TTS。
- release 未开启代码混淆（`isMinifyEnabled = false`），便于出问题时定位；上架前再按需开启。
- WebView 只能按系统默认输入设备采集；`enumerateDevices` 在真机通常只给出一个默认麦克风，
  网页端的「选择麦克风」下拉在手机上不会出现（`devices.length > 1` 才显示），由系统决定用哪个麦。
- 导出的配置保存到系统「下载」目录；Android 10 以下为应用专属目录（Toast 会提示路径）。
