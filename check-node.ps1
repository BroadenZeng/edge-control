param([string] $NodePath = 'node')
function Get-NodeVersion {
    param([string] $Path)
    $cmd = Get-Command -Name $Path -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { return $null }
    try {
        $v = & $cmd.Source --version 2>$null
        if ($LASTEXITCODE -eq 0 -and "$v" -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return "$v" }
    } catch { }
    return $null
}
if (Get-NodeVersion $NodePath) { exit 0 }
[Console]::Error.WriteLine('未找到可用的 Node.js 22 或更高版本。')
[Console]::Error.WriteLine('官方下载地址：https://nodejs.org/zh-cn/download')
if ($NodePath -ne 'node') {
    [Console]::Error.WriteLine('指定了自定义 NodePath，请检查该路径或手动安装。')
    exit 1
}
$winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $winget) {
    [Console]::Error.WriteLine('未找到 Windows 程序包管理器，请手动安装后重试。')
    exit 1
}
Write-Host '正在通过 Windows 程序包管理器安装 Node.js LTS。'
& $winget.Source install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements --disable-interactivity
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('自动安装未完成，请使用官方下载地址手动安装。'); exit 1 }
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
if (-not (Get-NodeVersion 'node')) { [Console]::Error.WriteLine('安装完成但当前窗口尚未识别到可用版本，请关闭并重新打开终端后重试。'); exit 1 }
Write-Host 'Node.js 已安装，可以继续。'
exit 0

