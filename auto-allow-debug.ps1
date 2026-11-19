param(
    [switch] $Once,
    [switch] $Strict,
    [switch] $StopAfterFirst,
    [switch] $Verbose,
    [int] $IntervalMs = 200,
    [int] $WindowSeconds = 0,
    [string] $LogPath = '',
    [string[]] $ProcNames = @('msedge', 'ApplicationFrameHost')
)

# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI/GBK when there is
# no BOM, so Chinese literals are rebuilt from code points instead of being written raw.
#
# Robustness rules learned the hard way:
#  - $ErrorActionPreference must NOT be Stop: one ElementNotAvailableException during a
#    UIA scan would kill the whole watcher.
#  - Every window is processed inside try/catch.
#  - Logging goes through Add-Content (unbuffered); redirected stdout is buffered and
#    makes the watcher look dead while it is actually running.

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

function Write-Log([string] $message) {
    if (-not $LogPath) { Write-Output $message; return }
    try {
        Add-Content -LiteralPath $LogPath -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $message) -Encoding UTF8
    } catch { }
}

function Get-CnText([int[]] $codes) { -join ($codes | ForEach-Object { [char] $_ }) }

# U+5141 U+8BB8 = allow ; U+8FDC U+7A0B U+8C03 U+8BD5 = remote debugging
# U+5E0C U+671B U+5B8C U+5168 U+63A7 U+5236 = "wants full control" (dialog body only)
$allowWord = Get-CnText @(0x5141, 0x8BB8)
$remoteWord = Get-CnText @(0x8FDC, 0x7A0B, 0x8C03, 0x8BD5)
$bodyWord = Get-CnText @(0x5E0C, 0x671B, 0x5B8C, 0x5168, 0x63A7, 0x5236)
$titleWord = $allowWord + $remoteWord

$bodyHints = if ($Strict) { @('Allow remote debugging', $titleWord) } else { @($bodyWord, 'wants full control', 'Allow remote debugging', $titleWord) }
$allowHints = @($allowWord, 'Allow')

function Invoke-AllowOnce {
    $root = $AE::RootElement
    $wins = $null
    try { $wins = $root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return $null }
    if (-not $wins) { return $null }

    foreach ($w in $wins) {
        try {
            $procName = (Get-Process -Id $w.Current.ProcessId -ErrorAction Stop).ProcessName
            if ($ProcNames -notcontains $procName) { continue }
        } catch { continue }

        try {
            $nodes = $w.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        } catch { continue }

        $hit = $null
        foreach ($e in $nodes) {
            try {
                $t = $e.Current.Name
                if (-not $t) { continue }
                foreach ($h in $bodyHints) { if ($t -like "*$h*") { $hit = $t; break } }
            } catch { continue }
            if ($hit) { break }
        }
        if (-not $hit) { continue }

        try {
            $btnCond = New-Object System.Windows.Automation.PropertyCondition(
                $AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
            $buttons = $w.FindAll($TS::Descendants, $btnCond)
        } catch { continue }

        foreach ($b in $buttons) {
            try {
                $bn = $b.Current.Name
                if (-not $bn) { continue }
                $isAllow = $false
                foreach ($ah in $allowHints) { if ($bn -eq $ah) { $isAllow = $true; break } }
                if (-not $isAllow) { continue }
                $pattern = $null
                if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref] $pattern)) {
                    $pattern.Invoke()
                    return $bn
                }
            } catch { continue }
        }
    }
    return $null
}

if ($Once) {
    $r = Invoke-AllowOnce
    if ($r) { Write-Log ("clicked: " + $r) } else { Write-Log 'no consent dialog found' }
    exit 0
}

Write-Log ("watcher start pid=" + $PID + " interval=" + $IntervalMs + "ms log=" + $LogPath)
$deadline = if ($WindowSeconds -gt 0) { (Get-Date).AddSeconds($WindowSeconds) } else { [datetime]::MaxValue }
$count = 0
$lastBeat = Get-Date
while ((Get-Date) -lt $deadline) {
    $r = $null
    try { $r = Invoke-AllowOnce } catch { }
    if ($r) {
        $count += 1
        Write-Log ("clicked: " + $r)
        if ($StopAfterFirst) { break }
        $lastBeat = Get-Date
    } elseif (((Get-Date) - $lastBeat).TotalSeconds -ge 60) {
        $lastBeat = Get-Date
        Write-Log ("alive, clicks so far: " + $count)
    }
    Start-Sleep -Milliseconds $IntervalMs
}
Write-Log ("watcher stop total clicks: " + $count)

