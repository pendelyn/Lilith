[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Prompt,

    [ValidateSet('ask', 'plan', 'agent')]
    [string]$Mode = 'ask',

    [string]$Workspace = (Get-Location).Path,

    [switch]$Worktree,

    [int]$HeartbeatSeconds = 20
)

$ErrorActionPreference = 'Stop'

# Tests point this at a fake agent.ps1. The real CLI stays the default.
$cursorAgent = if ($env:CURSOR_GROK_AGENT) { $env:CURSOR_GROK_AGENT } else {
    Join-Path $env:LOCALAPPDATA 'cursor-agent\agent.ps1'
}
if (-not (Test-Path -LiteralPath $cursorAgent)) {
    throw 'Cursor CLI not found. Install it from https://cursor.com/docs/cli/installation.'
}
if ($HeartbeatSeconds -lt 1) {
    throw 'HeartbeatSeconds must be at least 1.'
}

# The real agent.ps1 splats $args to node.exe. Windows PowerShell 5.1 quotes a
# path that contains spaces and leaves a trailing \ unescaped, so the second hop
# corrupts it. Format-ProcessArgument only covers the command line built here.
# Strip the slash before git -C, --workspace, or WorkingDirectory see it. Keep a
# drive root (C:\); TrimEnd would turn it into the drive-relative path C:.
if ($Workspace.Length -gt 3 -and $Workspace.EndsWith('\')) {
    $Workspace = $Workspace.TrimEnd('\')
}

$cliArgs = @(
    '-p',
    '--output-format', 'stream-json',
    '--sandbox', 'disabled', # Cursor sandbox is unavailable on native Windows.
    '--trust',
    '--model', 'grok-4.7-xhigh'
)

if ($Mode -ne 'agent') {
    $cliArgs += @('--mode', $Mode)
} else {
    $branchOutput = & git -C $Workspace branch --show-current 2>$null
    $gitExit = $LASTEXITCODE
    # Detached HEAD prints nothing. A null result has no Trim method.
    $branch = if ($null -eq $branchOutput) { '' } else { "$branchOutput".Trim() }
    if ($gitExit -ne 0 -or $branch -notmatch '^issue/\d+-') {
        throw 'Writing Grok runs require an issue/<number>-... branch.'
    }
    $cliArgs += '--force' # authorized unattended shell; Cursor CLI alias --yolo
}
if ($Worktree) {
    $cliArgs += '--worktree'
}
# Last, so a trailing \ cannot swallow a later flag such as --mode.
$cliArgs += @('--workspace', $Workspace)

# CommandLineToArgvW treats \" as an escaped quote. A quoted path that ends in
# \ therefore swallows the next argument, including --mode ask/plan.
function Format-ProcessArgument([string]$Value) {
    if ($null -eq $Value) { $Value = '' }
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $sb = New-Object System.Text.StringBuilder
    $bs = [char]92
    $dq = [char]34
    [void]$sb.Append($dq)
    $i = 0
    while ($i -lt $Value.Length) {
        $slashes = 0
        while ($i -lt $Value.Length -and $Value[$i] -eq $bs) {
            $slashes++
            $i++
        }
        if ($i -ge $Value.Length) {
            [void]$sb.Append($bs, ($slashes * 2))
            break
        }
        if ($Value[$i] -eq $dq) {
            [void]$sb.Append($bs, ($slashes * 2 + 1))
            [void]$sb.Append($dq)
        } else {
            if ($slashes -gt 0) { [void]$sb.Append($bs, $slashes) }
            [void]$sb.Append($Value[$i])
        }
        $i++
    }
    [void]$sb.Append($dq)
    return $sb.ToString()
}

function Stop-ProcessTree([System.Diagnostics.Process]$Process) {
    try {
        if ($Process.HasExited) { return }
    } catch {
        return
    }
    # Kill() on Windows PowerShell 5.1 does not take a process-tree flag.
    try {
        $Process.Kill($true)
        return
    } catch { }
    try {
        & taskkill.exe /PID $Process.Id /T /F > $null 2> $null
    } catch { }
    try {
        if (-not $Process.HasExited) { $Process.Kill() }
    } catch { }
}

# stream-json emits one event per line. Stdout stays a single result object so
# existing callers can parse it. Stderr gets event names and a heartbeat, because
# the model can sit silent for minutes and a json-only stream looks dead.
# Windows PowerShell 5.1 reads redirected pipes with the OEM code page and delivers
# DataReceived through a queue that Unregister-Event can drop. Read UTF-8 on a
# thread and join it after exit instead.
if (-not ('CursorGrok.Pipe' -as [type])) {
    $null = Add-Type -TypeDefinition @'
using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Threading;

namespace CursorGrok {
    public static class Pipe {
        public static ConcurrentQueue<string> OutLines = new ConcurrentQueue<string>();
        public static ConcurrentQueue<string> ErrLines = new ConcurrentQueue<string>();

        public static Thread Start(Stream stream, ConcurrentQueue<string> queue) {
            var reader = new StreamReader(stream, new UTF8Encoding(false), false, 4096, true);
            var thread = new Thread(() => Read(reader, queue));
            thread.IsBackground = true;
            thread.Start();
            return thread;
        }

        static void Read(StreamReader reader, ConcurrentQueue<string> queue) {
            try {
                string line;
                while ((line = reader.ReadLine()) != null) queue.Enqueue(line);
            } catch (IOException) {
            }
        }

        public static string Take(ConcurrentQueue<string> queue) {
            string line;
            if (queue.TryDequeue(out line)) return line;
            return null;
        }
    }
}
'@
}

$utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::InputEncoding = $utf8 } catch { }
try { [Console]::OutputEncoding = $utf8 } catch { }
$OutputEncoding = $utf8
$hostExe = (Get-Process -Id $PID).Path
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $hostExe
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.WorkingDirectory = $Workspace
$psi.Arguments = (@('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $cursorAgent) + $cliArgs |
    ForEach-Object { Format-ProcessArgument $_ }) -join ' '

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$result = $null

function Receive-ChildLines {
    $line = [CursorGrok.Pipe]::Take([CursorGrok.Pipe]::OutLines)
    while ($null -ne $line) {
        if (-not [string]::IsNullOrEmpty($line)) {
            if ($line -match '"type"\s*:\s*"result"') {
                $script:result = $line
            } else {
                $kind = if ($line -match '"type"\s*:\s*"([^"]+)"') { $Matches[1] } else { 'output' }
                if ($line -match '"subtype"\s*:\s*"([^"]+)"') {
                    $kind = "$kind/$($Matches[1])"
                }
                [Console]::Error.WriteLine("cursor-grok: $kind")
                [Console]::Error.Flush()
            }
        }
        $line = [CursorGrok.Pipe]::Take([CursorGrok.Pipe]::OutLines)
    }
    $line = [CursorGrok.Pipe]::Take([CursorGrok.Pipe]::ErrLines)
    while ($null -ne $line) {
        if (-not [string]::IsNullOrEmpty($line)) {
            [Console]::Error.WriteLine($line)
            [Console]::Error.Flush()
        }
        $line = [CursorGrok.Pipe]::Take([CursorGrok.Pipe]::ErrLines)
    }
}

$outThread = $null
$errThread = $null
try {
    [void]$proc.Start()
    $outThread = [CursorGrok.Pipe]::Start($proc.StandardOutput.BaseStream, [CursorGrok.Pipe]::OutLines)
    $errThread = [CursorGrok.Pipe]::Start($proc.StandardError.BaseStream, [CursorGrok.Pipe]::ErrLines)

    $stdinStream = $proc.StandardInput.BaseStream
    $writer = New-Object System.IO.StreamWriter($stdinStream, $utf8, 4096, $false)
    $writer.Write($Prompt)
    $writer.Dispose()

    $started = [datetime]::UtcNow
    $lastBeat = $started
    while (-not $proc.HasExited) {
        Receive-ChildLines
        $now = [datetime]::UtcNow
        if (($now - $lastBeat).TotalSeconds -ge $HeartbeatSeconds) {
            $elapsed = [int]($now - $started).TotalSeconds
            [Console]::Error.WriteLine("cursor-grok: waiting ${elapsed}s")
            [Console]::Error.Flush()
            $lastBeat = $now
        }
        if (-not $proc.HasExited) { Start-Sleep -Milliseconds 200 }
    }
    $proc.WaitForExit()
    if ($outThread) { $null = $outThread.Join(2000) }
    if ($errThread) { $null = $errThread.Join(2000) }
    Receive-ChildLines

    if ($result) {
        $code = $proc.ExitCode
        $bytes = $utf8.GetBytes($result + "`n")
        $rawOut = [Console]::OpenStandardOutput()
        $rawOut.Write($bytes, 0, $bytes.Length)
        $rawOut.Flush()
        exit $code
    }

    [Console]::Error.WriteLine('cursor-grok: no result event')
    [Console]::Error.Flush()
    if ($proc.ExitCode -ne 0) {
        exit $proc.ExitCode
    }
    exit 1
}
finally {
    try {
        if (-not $proc.HasExited) { Stop-ProcessTree $proc }
    } catch { }
    $proc.Dispose()
}
