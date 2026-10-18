<#
.SYNOPSIS
    一键构建「普通话模拟考试」安卓 APK：前端构建 -> 资源同步 -> Gradle 打包 -> 产物归档。

.DESCRIPTION
    流程（与 README 里的手工步骤等价）：
      1) 在 ..\psc-exam 执行 npm run build（tsc 类型检查 + vite 生产构建）
      2) 把 dist\* 同步到 app\src\main\assets（web 产物放在 assets 根，tts-shim.js 保留）
      3) gradlew assembleDebug / assembleRelease
      4) APK 复制到 out\ 并按版本号命名，输出 SHA256

    前置：JDK 17、Android SDK（Platform 34 + Build-Tools 34）、Node.js。
    可用 -JdkHome / -AndroidSdk 显式指定，也可用 JAVA_HOME / ANDROID_HOME / local.properties 自动探测。

.EXAMPLE
    .\build_apk.ps1                 # 前端 + release（默认 both）
    .\build_apk.ps1 -Variant release
    .\build_apk.ps1 -SkipWeb        # 只重新打包，不动前端
    .\build_apk.ps1 -WebOnly        # 只构建前端并同步资源
#>
[CmdletBinding()]
param(
    [ValidateSet('both', 'debug', 'release')]
    [string]$Variant = 'both',
    [switch]$SkipWeb,
    [switch]$WebOnly,
    [string]$JdkHome,
    [string]$AndroidSdk
)

$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot
$webSrc = Join-Path $root '..\psc-exam' | Resolve-Path -ErrorAction SilentlyContinue
$webSrc = if ($webSrc) { $webSrc.Path } else { Join-Path $root '..\psc-exam' }
$assets = Join-Path $root 'app\src\main\assets'
$outDir = Join-Path $root 'out'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "[失败] $msg" -ForegroundColor Red; exit 1 }

# ---------- 1. 前端构建 + 资源同步 ----------
function Build-Web {
    if (-not (Test-Path (Join-Path $webSrc 'package.json'))) { Fail "找不到前端工程：$webSrc" }
    Write-Step "构建前端 psc-exam（npm run build）"
    Push-Location $webSrc
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { Fail "npm run build 退出码 $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $dist = Join-Path $webSrc 'dist'
    if (-not (Test-Path (Join-Path $dist 'index.html'))) { Fail "前端产物缺失：$dist\index.html" }

    Write-Step "同步前端产物 -> app\src\main\assets"
    if (-not (Test-Path $assets)) { New-Item -ItemType Directory -Force -Path $assets | Out-Null }
    # 只清理 web 产物，保留原生脚本 tts-shim.js
    Get-ChildItem $assets -Force | Where-Object { $_.Name -ne 'tts-shim.js' } | ForEach-Object {
        if ($_.PSIsContainer) { Remove-Item -Recurse -Force $_.FullName } else { Remove-Item -Force $_.FullName }
    }
    Copy-Item -Recurse -Force (Join-Path $dist '*') $assets
    Get-ChildItem -Recurse $assets -File | ForEach-Object {
        Write-Host ("  {0,10}  {1}" -f $_.Length, $_.FullName.Substring($assets.Length + 1))
    }
}

# ---------- 2. 定位 JDK / Android SDK ----------
function Resolve-Toolchain {
    param([string]$Jdk, [string]$Sdk)

    if (-not $Jdk) { $Jdk = $env:JAVA_HOME }
    if (-not $Jdk -or -not (Test-Path (Join-Path $Jdk 'bin\java.exe'))) {
        $localTc = Join-Path $env:LOCALAPPDATA 'psc-android-toolchain'
        $cand = Get-ChildItem -Path (Join-Path $localTc 'jdkx'), 'C:\Program Files\Android\Android Studio\jbr', 'C:\Program Files\Java' -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'bin\java.exe') } | Select-Object -First 1
        if ($cand) { $Jdk = $cand.FullName }
    }
    if (-not $Jdk -or -not (Test-Path (Join-Path $Jdk 'bin\java.exe'))) {
        Fail "找不到 JDK 17：请设置 JAVA_HOME 或传 -JdkHome"
    }

    if (-not $Sdk) { $Sdk = $env:ANDROID_HOME }
    if (-not $Sdk) { $Sdk = $env:ANDROID_SDK_ROOT }
    if (-not $Sdk) {
        $lp = Join-Path $root 'local.properties'
        if (Test-Path $lp) {
            $line = (Get-Content $lp | Where-Object { $_ -match '^\s*sdk\.dir\s*=' })
            if ($line) { $Sdk = ($line -split '=', 2)[1].Trim() }
        }
    }
    if (-not $Sdk -or -not (Test-Path (Join-Path $Sdk 'platforms'))) {
        Fail "找不到 Android SDK：请设置 ANDROID_HOME 或传 -AndroidSdk"
    }
    # local.properties 里的 sdk.dir 常用正斜杠，统一成本地路径形式便于打印与排查
    $Sdk = $Sdk -replace '/', '\'

    return @{ Jdk = $Jdk; Sdk = $Sdk }
}

# ---------- 3. Gradle 打包 ----------
function Invoke-Gradle([string[]]$Tasks, $Tool) {
    $env:JAVA_HOME = $Tool.Jdk
    $env:PATH = (Join-Path $Tool.Jdk 'bin') + ';' + $env:PATH
    $env:ANDROID_HOME = $Tool.Sdk
    $env:ANDROID_SDK_ROOT = $Tool.Sdk

    Write-Step ("运行 Gradle：" + ($Tasks -join ' '))
    & (Join-Path $root 'gradlew.bat') -p $root @Tasks --console=plain
    if ($LASTEXITCODE -ne 0) { Fail "Gradle 退出码 $LASTEXITCODE" }
}

# ---------- 4. 归档产物 ----------
function Publish-Apk([string[]]$Variants) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $version = Select-String -Path (Join-Path $root 'app\build.gradle.kts') -Pattern 'versionName\s*=\s*"([^"]+)"' |
        Select-Object -First 1
    $ver = if ($version) { $version.Matches[0].Groups[1].Value } else { 'dev' }

    Write-Step "归档 APK -> out"
    foreach ($v in $Variants) {
        $src = Join-Path $root "app\build\outputs\apk\$v\app-$v.apk"
        if (-not (Test-Path $src)) { Write-Host "  [跳过] 未找到 $src" -ForegroundColor Yellow; continue }
        $dst = Join-Path $outDir "psc-exam-$ver-$v.apk"
        Copy-Item $src $dst -Force
        $hash = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
        $size = '{0:N2} MB' -f ((Get-Item $dst).Length / 1MB)
        Write-Host ("  {0}  {1}  SHA256={2}" -f (Split-Path $dst -Leaf), $size, $hash)
    }
    Write-Host "`n产物目录：$outDir" -ForegroundColor Green
}

# ---------- 主流程 ----------
if (-not $SkipWeb) { Build-Web }
if ($WebOnly) { Write-Host "`n[完成] 前端已构建并同步（未打包 APK）" -ForegroundColor Green; exit 0 }

$tool = Resolve-Toolchain -Jdk $JdkHome -Sdk $AndroidSdk
Write-Host ("JDK      = " + $tool.Jdk)
Write-Host ("Android  = " + $tool.Sdk)

switch ($Variant) {
    'debug'   { Invoke-Gradle @('assembleDebug') $tool;   Publish-Apk @('debug') }
    'release' { Invoke-Gradle @('assembleRelease') $tool; Publish-Apk @('release') }
    default   { Invoke-Gradle @('assembleDebug', 'assembleRelease') $tool; Publish-Apk @('debug', 'release') }
}

Write-Host "`n[完成] APK 构建成功" -ForegroundColor Green
