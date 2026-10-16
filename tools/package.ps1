# 生成扩展发布包。-CheckOnly 只检查清单，不创建文件、不读取签名密钥。
[CmdletBinding()]
param([switch]$CheckOnly, [string]$ChromePath)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$planJson = & node (Join-Path $PSScriptRoot 'package-plan.mjs')
if ($LASTEXITCODE -ne 0) { throw '发布清单校验失败，未执行打包。' }
$plan = ($planJson -join [Environment]::NewLine) | ConvertFrom-Json
Write-Host "发布版本：$($plan.version)，白名单文件：$($plan.files.Count) 个"
if ($CheckOnly) { Write-Host '只读校验通过，未生成 ZIP、CRX 或密钥。'; return }

$outputRoot = Join-Path $projectRoot 'dist'
if (Test-Path -LiteralPath $outputRoot) { throw 'dist 已存在，请先自行保留或清理旧产物，避免覆盖。' }
$stage = Join-Path $outputRoot 'extension'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($relative in $plan.files) {
  $target = Join-Path $stage $relative
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination $target
}
$zipPath = Join-Path $outputRoot "$($plan.name).zip"
$zipSources = @(Get-ChildItem -LiteralPath $stage | ForEach-Object { $_.FullName })
Compress-Archive -LiteralPath $zipSources -DestinationPath $zipPath -CompressionLevel Optimal
$artifacts = @($zipPath)

if ([string]::IsNullOrWhiteSpace($env:CRX_PRIVATE_KEY)) {
  Write-Host '未配置 CRX_PRIVATE_KEY：本次仅生成 ZIP。配置固定 PEM 私钥后可生成 CRX。'
} else {
  # 私钥仅写到临时目录，永远不放进扩展目录或上传产物。
  if ($env:CRX_PRIVATE_KEY -notmatch '-----BEGIN (RSA )?PRIVATE KEY-----') { throw 'CRX_PRIVATE_KEY 应是完整的 RSA PEM 私钥内容。' }
  $candidates = @($ChromePath, $env:CHROME_BIN,
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'))
  if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe' }
  $chrome = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
  if (!$chrome) { throw '找不到 Chrome，请通过 -ChromePath 指定可执行文件。' }
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
  $signingRoot = Join-Path $tempRoot ('proxy-timezone-signing-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $signingRoot | Out-Null
  try {
    $keyPath = Join-Path $signingRoot 'signing.pem'
    [IO.File]::WriteAllText($keyPath, $env:CRX_PRIVATE_KEY.Trim() + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    $profilePath = Join-Path $signingRoot 'profile'
    $chromeArgs = @("--pack-extension=`"$stage`"", "--pack-extension-key=`"$keyPath`"",
      "--user-data-dir=`"$profilePath`"", '--no-first-run', '--no-default-browser-check')
    $process = Start-Process -FilePath $chrome -ArgumentList $chromeArgs -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Chrome 打包失败，退出码 $($process.ExitCode)" }
    $rawCrx = "$stage.crx"
    if (!(Test-Path -LiteralPath $rawCrx)) { throw 'Chrome 没有生成 CRX 文件。' }
    $header = [IO.File]::ReadAllBytes($rawCrx)
    if ($header.Length -lt 12 -or [Text.Encoding]::ASCII.GetString($header, 0, 4) -ne 'Cr24' -or [BitConverter]::ToUInt32($header, 4) -ne 3) {
      throw '生成文件不是有效的 CRX3 容器。'
    }
    $crxPath = Join-Path $outputRoot "$($plan.name).crx"
    Move-Item -LiteralPath $rawCrx -Destination $crxPath
    $artifacts += $crxPath
  } finally {
    # 删除前确认最终绝对路径仍是系统临时目录下、本脚本创建的独立目录。
    $resolvedSigning = [IO.Path]::GetFullPath($signingRoot)
    if ((Split-Path -Parent $resolvedSigning) -eq $tempRoot -and (Split-Path -Leaf $resolvedSigning).StartsWith('proxy-timezone-signing-')) {
      Remove-Item -LiteralPath $resolvedSigning -Recurse -Force
    }
  }
}
$hashLines = foreach ($artifact in $artifacts) {
  '{0}  {1}' -f (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path -Leaf $artifact)
}
$hashLines | Set-Content -LiteralPath (Join-Path $outputRoot 'SHA256SUMS.txt') -Encoding utf8NoBOM
$plan | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outputRoot 'package-files.json') -Encoding utf8NoBOM
Write-Host '发布包及校验和已生成于 dist；原生宿主机需从源代码单独获取。'
