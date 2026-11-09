# 把 scripts/pre-push.hook 装成 .git/hooks/pre-push（换机器/重新 clone 后跑一次）
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $PSScriptRoot "pre-push.hook"
$dst = Join-Path $root ".git\hooks\pre-push"
if (-not (Test-Path $src)) { Write-Host "找不到 $src" -ForegroundColor Red; exit 1 }
$text = [System.IO.File]::ReadAllText($src).Replace("`r`n", "`n")
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($dst, $text, $utf8)
Write-Host "已安装 pre-push hook: $dst" -ForegroundColor Green
Write-Host "效果：每次 git push 后 150 秒自动清一次香港 nginx 缓存（日志 D:\myblog\.purge.log）"
