#Requires -Version 5.1
<#
.SYNOPSIS
    GPT-SoVITS 本地服务启动器（Windows）。

.DESCRIPTION
    本脚本只负责一件事：**挑对解释器，然后把控制权交给 trainer/server.py**。

    为什么「挑对解释器」值得单独写一个脚本：
    torch 装在 GPT-SoVITS 整合包自带的 `runtime/` 里，用系统 Python 启动本服务
    会在 `import torch` 时直接失败；而整合包里的解释器路径随发行方式而异
    （runtime/python.exe、runtime/bin/python3、venv/...）。这里按顺序探测，
    并且以「能否 import torch」作为最终判据 —— 而不是猜路径。

    其余智能（定位整合包、体检报告、下一步该做什么）都在 server.py 里。

    语法约定：PowerShell 要求 } catch { 与 } else { 写在同一行，
    分成两行会解析出错，因此下文均遵循该写法。

.EXAMPLE
    scripts\start.ps1
    scripts\start.ps1 -Check
    scripts\start.ps1 -SovitsHome D:\GPT-SoVITS -Port 9881
    npm run dev:sovits -- --home D:/GPT-SoVITS
#>
param(
    # 注意：不能叫 $Home —— 那是 PowerShell 的自动变量，赋值会直接报错
    [string]$SovitsHome,
    [int]$Port = 0,
    [string]$Device,
    [string]$Version,
    [ValidateSet('local', 'public')][string]$Mode,
    [switch]$Check,
    [switch]$NoOpen,
    [switch]$DryRun,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 默认用 ANSI 代码页处理管道输出，
# 而 Python 侧输出的是 UTF-8 —— 不显式设置的话，中文日志会整片变成乱码。
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
    # 某些宿主（如受限的 CI shell）不允许改编码，退化为默认行为即可
}
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'

function Write-Step {
    param([string]$Message)
    Write-Host ('  · ' + $Message) -ForegroundColor Cyan
}

function Write-Warn {
    param([string]$Message)
    Write-Host ('  ! ' + $Message) -ForegroundColor Yellow
}

function Stop-WithError {
    param([string]$Message)
    Write-Host ''
    Write-Host ('  [x] ' + $Message) -ForegroundColor Red
    Write-Host ''
    exit 1
}

# 用子进程判断解释器能力，避免在本进程里 import 重型依赖。
# 刻意不做超时控制：`import torch` 本身就要 5~15 秒，起一个后台 Job 的开销与
# 复杂度都超过收益，而且 Job 环境在受限终端里未必可用。
function Test-Interpreter {
    param([string]$Exe, [string]$Code)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $Exe -c $Code 2>$null 1>$null
    $code = $LASTEXITCODE
    $ErrorActionPreference = $previous
    return ($code -eq 0)
}

function Get-BundledPythons {
    param([string]$Root)
    $candidates = @()
    if ($SovitsHome) { $candidates += (Join-Path $SovitsHome 'runtime\python.exe') }
    $dirs = Get-ChildItem -Path $Root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^gpt[-_]?sovits' }
    foreach ($dir in $dirs) {
        foreach ($rel in @('runtime\python.exe', 'runtime\bin\python3', 'venv\Scripts\python.exe', '.venv\Scripts\python.exe')) {
            $candidates += (Join-Path $dir.FullName $rel)
        }
    }
    return ($candidates | Where-Object { Test-Path $_ })
}

Write-Host ''
Write-Host '  GPT-SoVITS 本地服务 · 启动器' -ForegroundColor Green
Write-Host ''

$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$trainerDir = Join-Path $root 'trainer'
if (-not (Test-Path (Join-Path $trainerDir 'server.py'))) {
    Stop-WithError -Message ('未找到 Python 服务入口：' + (Join-Path $trainerDir 'server.py'))
}

# ---------- 1. 选择解释器 ----------
# 判据是「能不能 import torch」，而不是「路径看起来对不对」
$python = $null
foreach ($candidate in @(Get-BundledPythons -Root $root)) {
    Write-Step -Message ('探测整合包解释器：' + $candidate)
    if (Test-Interpreter -Exe $candidate -Code 'import torch') {
        $python = $candidate
        break
    }
}

if (-not $python) {
    foreach ($name in @('python', 'python3')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -eq $cmd) { continue }
        if (Test-Interpreter -Exe $cmd.Source -Code 'import torch') {
            $python = $cmd.Source
            break
        }
    }
}

if (-not $python) {
    Write-Warn -Message '没有找到能 import torch 的解释器'
    Write-Host ''
    Write-Host '  服务仍然可以启动，但推理与训练会不可用。请任选一种方式解决：'
    Write-Host '    1) 把 GPT-SoVITS 整合包解压到本项目同级目录（推荐，自带 runtime 与 torch）'
    Write-Host '    2) 用 -SovitsHome 指定整合包根目录，例如： scripts\start.ps1 -SovitsHome D:\GPT-SoVITS'
    Write-Host '    3) 在你自己的 Python 环境里装好 torch 后，用该解释器启动 trainer/server.py'
    Write-Host ''
    foreach ($name in @('python', 'python3')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $cmd) { $python = $cmd.Source; break }
    }
    if (-not $python) {
        Stop-WithError -Message '连一个可用的 Python 都没有，请先安装 Python 3.9+ 并加入 PATH'
    }
}

Write-Step -Message ('使用解释器：' + $python)

# ---------- 1.5 新板块 vendor 预检 ----------
# 语音变声（vendor/rvc）与歌声转换（vendor/ddsp-svc）是 git submodule。
# 缺了不会阻断启动 —— 现有 GPT-SoVITS 链路不受影响 —— 但要明确告诉用户怎么补。
foreach ($vendor in @('vendor\rvc', 'vendor\ddsp-svc')) {
    $vendorPath = Join-Path $root $vendor
    if (Test-Path (Join-Path $vendorPath 'README.md')) { continue }
    if (Test-Path (Join-Path $vendorPath 'infer-web.py')) { continue }
    if (Test-Path (Join-Path $vendorPath 'main_reflow.py')) { continue }
    Write-Warn -Message ('未找到 ' + $vendor + '（语音变声 / 歌声转换板块不可用）')
    Write-Host '      → 执行 git submodule update --init vendor/rvc vendor/ddsp-svc 拉取' -ForegroundColor Gray
}

# ---------- 2. 补齐服务依赖 ----------
if (-not $SkipInstall) {
    Write-Step -Message '检查服务依赖（fastapi / uvicorn / pydantic / python-multipart / PyYAML）'
    $probe = 'import fastapi, uvicorn, pydantic, multipart, yaml'
    if (Test-Interpreter -Exe $python -Code $probe) {
        Write-Step -Message '依赖已就绪'
    } else {
        Write-Step -Message '正在安装缺失依赖…'
        & $python -m pip install -r (Join-Path $trainerDir 'requirements.txt') --disable-pip-version-check
        if ($LASTEXITCODE -ne 0) {
            Write-Warn -Message '依赖安装失败（可能是没有网络）。若整合包环境已自带这些包，可加 -SkipInstall 跳过'
        }
    }
}

# ---------- 3. 交给 server.py ----------
# 不能用 $args —— 那是 PowerShell 的自动变量
$serverArgs = @()
if ($Check) { $serverArgs += '--check' }
if ($Port -gt 0) { $serverArgs += @('--port', $Port) }
if ($SovitsHome) { $serverArgs += @('--home', $SovitsHome) }
if ($Device) { $serverArgs += @('--device', $Device) }
if ($Version) { $serverArgs += @('--version', $Version) }
if ($Mode) { $serverArgs += @('--mode', $Mode) }
if ($NoOpen -or $Mode -eq 'public') { $serverArgs += '--no-open' }
if ($DryRun) { $serverArgs += '--dry-run' }

Write-Step -Message '交给 server.py 做环境体检'
Write-Host ''

Set-Location $trainerDir
& $python (Join-Path $trainerDir 'server.py') @serverArgs
exit $LASTEXITCODE
