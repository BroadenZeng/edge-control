param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('tab_download_watch', 'tab_monitor', 'tab_dialog', 'tab_hover', 'tab_snapshot', 'tab_action', 'tab_wait', 'tab_scroll', 'tab_key', 'tab_upload', 'tab_activate', 'edge_status', 'edge_open', 'tabs_list', 'tab_open', 'tab_eval', 'tab_click', 'tab_screenshot', 'tab_cookies', 'tm_verify', 'tm_push', 'tm_scripts', 'fs_read', 'fs_write', 'run_command')]
    [string] $Tool,

    [hashtable] $Arguments = @{},

    # -Ensure routes the call through the persistent HTTP bridge: one CDP
    # connection, so the browser's debugging consent is requested once instead
    # of on every call. Without it the script does a one-shot stdio call, which
    # opens a new CDP connection each time.
    #
    # Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI/GBK
    # when there is no BOM, and non-ASCII comment text silently swallows the
    # following line (it removed the -Ensure parameter once).
    [switch] $Ensure,

    [string] $ServerPath = '',

    [string] $NodePath = 'node'
)

$ErrorActionPreference = 'Stop'
if (-not $ServerPath) { $ServerPath = Join-Path $PSScriptRoot 'mcp-edge-server.mjs' }
if (-not (Test-Path -LiteralPath $ServerPath)) { throw "server not found: $ServerPath" }

$callScript = Join-Path $PSScriptRoot 'mcp-call.mjs'
& (Join-Path $PSScriptRoot 'check-node.ps1') -NodePath $NodePath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
$nodeCommand = Get-Command -Name $NodePath -CommandType Application -ErrorAction Stop | Select-Object -First 1

if ($Ensure) {
    # JSON travels through a file: PowerShell 5.1 strips inner quotes when
    # handing arguments to a native executable.
    if (-not $env:MCP_HTTP_PORT) { $env:MCP_HTTP_PORT = '9333' }

    $request = @{
        jsonrpc = '2.0'
        id      = 1
        method  = 'tools/call'
        params  = @{ name = $Tool; arguments = $Arguments }
    } | ConvertTo-Json -Depth 30 -Compress

    $tmp = Join-Path $env:TEMP ("mcp-ensure-" + [guid]::NewGuid() + ".json")
    try {
        Set-Content -LiteralPath $tmp -Value $request -Encoding UTF8 -NoNewline
        & $nodeCommand.Source $ServerPath --ensure ("@" + $tmp)
        $exitCode = $LASTEXITCODE
        if ($null -eq $exitCode) { $exitCode = 1 }
    }
    finally {
        Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
    }
    exit $exitCode
}

$argumentsJson = ConvertTo-Json -InputObject $Arguments -Depth 30 -Compress
$tmp2 = Join-Path $env:TEMP ("mcp-args-" + [guid]::NewGuid() + ".json")

try {
    Set-Content -LiteralPath $tmp2 -Value $argumentsJson -Encoding UTF8 -NoNewline
    & $nodeCommand.Source $callScript $Tool ("@" + $tmp2) $ServerPath
    $exitCode = $LASTEXITCODE
    if ($null -eq $exitCode) { $exitCode = 1 }
}
finally {
    Remove-Item -LiteralPath $tmp2 -ErrorAction SilentlyContinue
}
exit $exitCode

