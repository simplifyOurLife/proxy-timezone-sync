# 代理时区自动切换 · 原生宿主机安装脚本（Windows）
# ------------------------------------------------------------------
# 用法（普通 PowerShell 即可，不需要管理员）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId <你的扩展ID>
# 卸载：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ExtensionId <你的扩展ID> -Uninstall
#
# 脚本做四件事：
#   1. 找到本机 Python
#   2. 生成 run_host.bat 启动器（Chrome 只认可执行文件，不能直接跑 .py）
#   3. 生成原生消息宿主清单 JSON
#   4. 往注册表 HKCU 写一条注册（只影响当前用户，不动系统全局）

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [string]$HostName = 'com.fj.tz.proxy_probe',
  [ValidateSet('chrome', 'edge', 'brave', 'chromium', 'all')][string]$Browser = 'chrome',
  [string]$Python = '',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostScript = Join-Path $root 'proxy_probe_host.py'
$batPath = Join-Path $root 'run_host.bat'
$manifestPath = Join-Path $root ($HostName + '.json')

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Get-RegistryKeyFor([string]$name, [string]$browser) {
  switch ($browser) {
    'chrome'   { return "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$name" }
    'edge'     { return "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$name" }
    'brave'    { return "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$name" }
    'chromium' { return "HKCU:\Software\Chromium\NativeMessagingHosts\$name" }
    default    { return "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$name" }
  }
}

$browsers = if ($Browser -eq 'all') { @('chrome', 'edge', 'brave', 'chromium') } else { @($Browser) }
$extensionIdClean = $ExtensionId.Trim().ToLower()

# ----------------------------------------------------------------------
# 卸载
# ----------------------------------------------------------------------
if ($Uninstall) {
  foreach ($b in $browsers) {
    $key = Get-RegistryKeyFor $HostName $b
    if (Test-Path $key) {
      Remove-Item -Path $key -Recurse -Force
      Write-Host "[删除] $b -> $key" -ForegroundColor Yellow
    } else {
      Write-Host "[跳过] $b 未注册" -ForegroundColor DarkGray
    }
  }
  if (Test-Path $manifestPath) { Remove-Item $manifestPath -Force }
  if (Test-Path $batPath) { Remove-Item $batPath -Force }
  Write-Host ''
  Write-Host '已卸载。重启 Chrome 生效。' -ForegroundColor Green
  exit 0
}

# ----------------------------------------------------------------------
# 校验扩展 ID
# ----------------------------------------------------------------------
if ($extensionIdClean -notmatch '^[a-p]{32}$') {
  Write-Host "警告：扩展 ID 看起来不对：$ExtensionId" -ForegroundColor Yellow
  Write-Host '      正常形如 pabcdefghijklmnopabcdefghijklmnop（32 个 a-p 的小写字母）' -ForegroundColor Yellow
  Write-Host '      ID 可以在扩展设置页复制（本扩展设置页有「复制」按钮）' -ForegroundColor Yellow
}

# ----------------------------------------------------------------------
# 找 Python
# ----------------------------------------------------------------------
function Resolve-Python([string]$preferred) {
  $candidates = @()
  if ($preferred) { $candidates += @($preferred) }
  foreach ($cand in @('py', 'python', 'python3')) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
  }
  foreach ($c in $candidates) {
    try {
      if ($c -like '*py.exe' -or (Split-Path $c -Leaf) -eq 'py.exe') {
        $out = & $c -3 -c "import sys;print(sys.executable)" 2>$null
      } else {
        $out = & $c -c "import sys;print(sys.executable)" 2>$null
      }
      $path = ($out | Select-Object -First 1)
      if ($path -and (Test-Path $path)) {
        # 排除 Microsoft Store 的假 python 存根
        if ($path -notlike '*WindowsApps*') { return $path }
      }
    } catch {
      continue
    }
  }
  return $null
}

$pythonExe = Resolve-Python $Python
if (-not $pythonExe) {
  Write-Host '没有找到可用的 Python。' -ForegroundColor Red
  Write-Host '请先安装 Python 3（https://www.python.org/downloads/windows/ ），安装时勾选 Add to PATH，然后重跑本脚本。' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $hostScript)) {
  Write-Host "找不到宿主脚本：$hostScript" -ForegroundColor Red
  exit 1
}

Write-Host "[1/4] Python: $pythonExe" -ForegroundColor Green

# ----------------------------------------------------------------------
# 生成启动器
# ----------------------------------------------------------------------
$bat = "@echo off`r`n`"$pythonExe`" `"$hostScript`" %*`r`n"
Write-Utf8NoBom $batPath $bat
Write-Host "[2/4] 启动器: $batPath" -ForegroundColor Green

# ----------------------------------------------------------------------
# 生成宿主清单
# ----------------------------------------------------------------------
$manifest = [ordered]@{
  name            = $HostName
  description     = 'Proxy timezone sync - local proxy/process probe host'
  path            = $batPath
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$extensionIdClean/")
}
Write-Utf8NoBom $manifestPath ($manifest | ConvertTo-Json -Depth 5)
Write-Host "[3/4] 清单: $manifestPath" -ForegroundColor Green

# ----------------------------------------------------------------------
# 注册
# ----------------------------------------------------------------------
foreach ($b in $browsers) {
  $key = Get-RegistryKeyFor $HostName $b
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(Default)' -Value $manifestPath
  Write-Host "[4/4] 已注册 $b -> $key" -ForegroundColor Green
}

# ----------------------------------------------------------------------
# 自检：真的给宿主发一条 probe 消息，看它回不回 JSON
# ----------------------------------------------------------------------
Write-Host ''
Write-Host '自检中（真的跟宿主通讯一次）…' -ForegroundColor Cyan
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $pythonExe
  $psi.Arguments = '"' + $hostScript + '"'
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)

  $body = [System.Text.Encoding]::UTF8.GetBytes('{"cmd":"probe"}')
  $head = [BitConverter]::GetBytes([int]$body.Length)
  $proc.StandardInput.BaseStream.Write($head, 0, 4)
  $proc.StandardInput.BaseStream.Write($body, 0, $body.Length)
  $proc.StandardInput.BaseStream.Flush()
  $proc.StandardInput.Close()

  $ms = New-Object System.IO.MemoryStream
  $buf = New-Object byte[] 8192
  while (($n = $proc.StandardOutput.BaseStream.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) }
  $proc.WaitForExit(15000) | Out-Null

  $all = $ms.ToArray()
  if ($all.Length -ge 4) {
    $len = [BitConverter]::ToInt32($all, 0)
    $take = [Math]::Min($len, $all.Length - 4)
    $json = [System.Text.Encoding]::UTF8.GetString($all, 4, $take)
    $obj = $json | ConvertFrom-Json
    if ($obj.ok) {
      Write-Host ("自检通过：命中 {0} 个代理相关进程" -f $obj.processes.Count) -ForegroundColor Green
      foreach ($pr in $obj.processes) {
        Write-Host ("   - {0} (PID {1}) 监听端口 [{2}]" -f $pr.name, $pr.pid, (($pr.ports) -join ', ')) -ForegroundColor DarkGray
      }
      if ($obj.systemProxy -and $obj.systemProxy.server) {
        Write-Host ("   系统代理: {0} (enabled={1})" -f $obj.systemProxy.server, $obj.systemProxy.enabled) -ForegroundColor DarkGray
      }
    } else {
      Write-Host ("宿主返回了错误：{0}" -f $obj.error) -ForegroundColor Yellow
    }
  } else {
    Write-Host '自检失败：宿主没有返回有效数据' -ForegroundColor Yellow
    $err = $proc.StandardError.ReadToEnd()
    if ($err) { Write-Host $err -ForegroundColor DarkGray }
  }
} catch {
  Write-Host ('自检异常：' + $_.Exception.Message) -ForegroundColor Yellow
}

Write-Host ''
Write-Host '完成！' -ForegroundColor Green
Write-Host '下一步：' -ForegroundColor Green
Write-Host '  1. 完全退出并重启 Chrome（注册表在启动时读取）'
Write-Host '  2. 打开本扩展的设置页，点「授权 nativeMessaging 权限」'
Write-Host '  3. 勾上「启用原生宿主机探测」，再点保存并重新检测'
Write-Host ''
Write-Host '卸载：加 -Uninstall 参数重跑本脚本即可。' -ForegroundColor DarkGray
