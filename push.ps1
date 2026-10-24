#Requires -Version 5.1
<#
.SYNOPSIS
    自动提交并推送当前仓库。任何一步失败都会按递增间隔重试，直到成功。

.DESCRIPTION
    流程：git add -A -> git commit（有改动时）-> git push。
    push 失败会自动等待并重试；若远端有新提交（rejected / non-fast-forward），
    会先尝试 git pull --rebase --autostash 再重试。默认无限重试，Ctrl+C 可随时中断。

    「提交失败」包含两种情况：commit 失败（钩子/身份配置）与 push 失败（网络/认证）。
    两者都会重试，所以退出码 0 表示确实已经推送到远端。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\push.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\push.ps1 -Message "fix: 修复结算" -Interval 3 -MaxInterval 30

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\push.ps1 -MaxRetries 10 -NoRebase

.NOTES
    首次推送若提示认证失败，请先手动执行一次 git push 完成 GitHub 登录。
#>
[CmdletBinding()]
param(
    # 提交信息；留空则自动生成 "auto: 时间戳"
    [string]$Message = "",
    # 仓库路径；留空则优先用脚本所在目录，其次当前目录
    [string]$RepoPath = "",
    [string]$Remote = "origin",
    # 目标分支；留空取当前分支
    [string]$Branch = "",
    # 首次重试等待秒数（之后翻倍）
    [int]$Interval = 5,
    # 退避等待上限秒数
    [int]$MaxInterval = 60,
    # 最大尝试次数；0 = 无限重试
    [int]$MaxRetries = 0,
    # 禁止自动 rebase（远端有新提交时只重试，不改写历史）
    [switch]$NoRebase
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
# 禁止 git 在终端里交互式索要账号密码，避免脚本卡死
$env:GIT_TERMINAL_PROMPT = '0'

function Write-Step($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host $msg -ForegroundColor Green }
function Write-Warn($msg) { Write-Host $msg -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host $msg -ForegroundColor Red }

# ---------- 定位仓库 ----------
if (-not $RepoPath) {
    if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '.git'))) { $RepoPath = $PSScriptRoot }
    else { $RepoPath = (Get-Location).Path }
}
if (-not (Test-Path $RepoPath)) {
    Write-Fail "路径不存在：$RepoPath"
    exit 1
}

$probeLines = & git -C $RepoPath rev-parse --show-toplevel 2>&1 | ForEach-Object { "$_" }
$probeCode = $LASTEXITCODE
$repo = ($probeLines | Out-String).Trim()
if ($probeCode -ne 0 -or -not $repo -or -not (Test-Path $repo)) {
    Write-Fail "不是 git 仓库：$RepoPath"
    exit 1
}
Set-Location $repo
Write-Step "仓库：$repo"

# 统一调用 git：输出转纯文本，避免 PowerShell 把 stderr 渲染成报错块
function Invoke-Git {
    param([string[]]$GitArgs)
    $lines = & git -C $repo @GitArgs 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
    }
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Code = $code; Output = (($lines | Out-String).Trim()) }
}

if (-not $Branch) {
    # 空仓库（尚无任何提交）时 rev-parse HEAD 会失败，这种情况要用 symbolic-ref 取分支名
    $r = Invoke-Git @('symbolic-ref', '--quiet', '--short', 'HEAD')
    if ($r.Code -ne 0 -or -not $r.Output) {
        $r = Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')
    }
    $Branch = $r.Output
}
if (-not $Branch -or $Branch -eq 'HEAD') {
    Write-Fail "无法确定当前分支（空仓库且未指定分支，或处于 detached HEAD）。"
    Write-Fail "请在仓库里执行 git checkout -b main 后重试，或直接指定 -Branch main。"
    exit 1
}
Write-Step "分支：$Branch  ->  $Remote"

if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = "auto: " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
}

# ---------- 重试主循环 ----------
$attempt = 0
$wait = [Math]::Max(1, $Interval)
$committed = 0
$startedAt = Get-Date

while ($true) {
    $attempt++
    Write-Step "--- 第 $attempt 次尝试 ---"

    # 1) 暂存全部改动
    $null = Invoke-Git @('add', '-A')
    $diff = Invoke-Git @('diff', '--cached', '--quiet')
    $hasStaged = ($diff.Code -ne 0)

    $commitFailed = $false

    # 2) 有改动则提交
    if ($hasStaged) {
        $c = Invoke-Git @('commit', '-m', $Message)
        if ($c.Code -eq 0) {
            $committed++
            Write-Ok "✅ 已提交：$Message"
        }
        else {
            $commitFailed = $true
            Write-Fail "❌ 提交失败："
            Write-Host $c.Output
            Write-Warn "常见原因：pre-commit 钩子报错 / 未配置 user.name、user.email / 索引被占用。"
        }
    }

    # 3) 没有改动且没有待推送的提交 -> 无事可做
    if (-not $hasStaged -and -not $commitFailed) {
        $up = Invoke-Git @('rev-parse', '--abbrev-ref', '@{u}')
        $hasUpstream = ($up.Code -eq 0 -and $up.Output -and $up.Output -notmatch 'fatal|no upstream')

        $ahead = 1
        if ($hasUpstream) {
            $cnt = Invoke-Git @('rev-list', '--count', '@{u}..HEAD')
            $ahead = 1
            if ($cnt.Code -eq 0 -and $cnt.Output -match '^\d+$') { $ahead = [int]$cnt.Output }
        }

        if ($ahead -le 0) {
            Write-Ok "✅ 工作区干净且已与远端同步，无需提交。"
            exit 0
        }
    }

    # 4) 推送
    if (-not $commitFailed) {
        $p = Invoke-Git @('push', '--set-upstream', $Remote, $Branch)
        if ($p.Code -eq 0) {
            $cost = [int](((Get-Date) - $startedAt).TotalSeconds)
            Write-Ok "✅ 推送成功（$Remote/$Branch，本次共提交 $committed 次，耗时 ${cost}s）"
            exit 0
        }

        Write-Fail "❌ 推送失败："
        Write-Host $p.Output

        # 远端有新提交时先变基，再进入下一轮重试
        if (-not $NoRebase -and $p.Output -match 'rejected|non-fast-forward|fetch first|behind') {
            Write-Warn "检测到远端有新提交，尝试 git pull --rebase --autostash ..."
            $rb = Invoke-Git @('pull', '--rebase', '--autostash', $Remote, $Branch)
            if ($rb.Code -ne 0) {
                if ($rb.Output -match 'CONFLICT|conflict') {
                    $null = Invoke-Git @('rebase', '--abort')
                    Write-Fail "❌ rebase 冲突，已中止变基。请手动解决冲突后再运行本脚本。"
                    Write-Host $rb.Output
                    exit 1
                }
                Write-Warn "变基未完成（可能是网络问题），稍后重试。"
                Write-Host $rb.Output
            }
            else {
                Write-Ok "🔀 已变基到远端最新提交。"
            }
        }
    }

    # 5) 退避等待
    if ($MaxRetries -gt 0 -and $attempt -ge $MaxRetries) {
        Write-Fail "❌ 已达最大尝试次数 $MaxRetries，放弃。"
        exit 1
    }
    Write-Warn "⏳ ${wait}s 后重试（Ctrl+C 可终止）..."
    Start-Sleep -Seconds $wait
    # 指数退避：Interval * 2^n，封顶 MaxInterval
    $backoff = [Math]::Max(1, $Interval) * [Math]::Pow(2, [Math]::Min($attempt, 8))
    $wait = [int][Math]::Min([Math]::Max(1, $MaxInterval), $backoff)
    if ($wait -lt 1) { $wait = [Math]::Max(1, $Interval) }
}
