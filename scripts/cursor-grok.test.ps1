$ErrorActionPreference = 'Stop'
$wrapper = Join-Path $PSScriptRoot 'cursor-grok.ps1'
$failed = @()
$utf8 = New-Object System.Text.UTF8Encoding $false
$hostExe = (Get-Process -Id $PID).Path

function Assert-True($Condition, $Message) {
    if (-not $Condition) {
        $script:failed += $Message
    }
}

function Short-Text([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $flat = $Text -replace '\s+', ' '
    if ($flat.Length -gt 500) { return $flat.Substring(0, 500) }
    return $flat
}

function Get-Text([byte[]]$Bytes) {
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return '' }
    return $script:utf8.GetString($Bytes)
}

function Get-StdErrText([byte[]]$Bytes) {
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return '' }
    $utf16 = ($Bytes.Length -ge 2 -and $Bytes[0] -eq 0xFF -and $Bytes[1] -eq 0xFE) -or
        ($Bytes.Length -ge 4 -and $Bytes[1] -eq 0 -and $Bytes[3] -eq 0 -and $Bytes[0] -ne 0)
    if ($utf16) { return [System.Text.Encoding]::Unicode.GetString($Bytes) }
    return $script:utf8.GetString($Bytes)
}

function Test-BranchGuard([string]$Text) {
    $body = $Text -match 'Writing Grok runs require'
    $detail = ($Text -match 'issue/<number>') -or ($Text -match 'issue/_x003C_number')
    return ($body -and $detail)
}

function Test-HasBytes([byte[]]$Hay, [byte[]]$Needle) {
    if ($null -eq $Needle -or $Needle.Length -eq 0) { return $true }
    if ($null -eq $Hay -or $Hay.Length -lt $Needle.Length) { return $false }
    for ($i = 0; $i -le $Hay.Length - $Needle.Length; $i++) {
        $match = $true
        for ($j = 0; $j -lt $Needle.Length; $j++) {
            if ($Hay[$i + $j] -ne $Needle[$j]) { $match = $false; break }
        }
        if ($match) { return $true }
    }
    return $false
}

function Get-FlagValue($Argv, [string]$Name) {
    $list = @($Argv)
    for ($i = 0; $i -lt $list.Count; $i++) {
        if ($list[$i] -eq $Name -and ($i + 1) -lt $list.Count) { return [string]$list[$i + 1] }
    }
    return $null
}

function Test-SameBytes([byte[]]$Got, [byte[]]$Want) {
    $g = if ($null -eq $Got) { New-Object byte[] 0 } else { [byte[]]$Got }
    $w = if ($null -eq $Want) { New-Object byte[] 0 } else { [byte[]]$Want }
    if ($g.Length -ne $w.Length) { return $false }
    for ($i = 0; $i -lt $g.Length; $i++) {
        if ($g[$i] -ne $w[$i]) { return $false }
    }
    return $true
}

$savedAgent = $env:CURSOR_GROK_AGENT
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('cursor-grok-test-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$fake = Join-Path $tmp 'fake-agent.ps1'
$launcher = Join-Path $tmp 'launch.ps1'

# Fake CLI only. Never clear CURSOR_GROK_AGENT before a launch, and never point
# agent mode at the repo that contains this test.
[System.IO.File]::WriteAllText($fake, @'
$ErrorActionPreference = 'Stop'
$capture = $env:CURSOR_GROK_CAPTURE
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $capture 'self.pid'), "$PID")
$argArray = New-Object string[] $args.Count
for ($i = 0; $i -lt $args.Count; $i++) { $argArray[$i] = [string]$args[$i] }
[System.IO.File]::WriteAllLines((Join-Path $capture 'args.txt'), $argArray, $utf8)
$ms = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($ms)
[System.IO.File]::WriteAllBytes((Join-Path $capture 'stdin.bin'), $ms.ToArray())
$mode = $env:CURSOR_GROK_FAKE_MODE
if ($mode -eq 'empty') {
    $code = 0
    if ($env:CURSOR_GROK_FAKE_EXIT) { $code = [int]$env:CURSOR_GROK_FAKE_EXIT }
    exit $code
}
if ($mode -eq 'slow') {
    [Console]::Error.WriteLine('connection lost sample')
    [Console]::Error.Flush()
    Start-Sleep -Seconds 3
}
if ($mode -eq 'burst') {
    foreach ($n in 1..30) { [Console]::Error.WriteLine("burst-$n") }
    [Console]::Error.Flush()
}
if ($mode -eq 'tree') {
    $child = Start-Process -FilePath (Get-Process -Id $PID).Path -PassThru -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-Command', 'Start-Sleep -Seconds 90'
    )
    [System.IO.File]::WriteAllText((Join-Path $capture 'grand.pid'), [string]$child.Id)
    Start-Sleep -Seconds 90
    exit 0
}
$stdout = [Console]::OpenStandardOutput()
$writer = New-Object System.IO.StreamWriter($stdout, $utf8, 1024, $true)
$writer.NewLine = "`n"
$writer.WriteLine('{"type":"assistant","subtype":"delta"}')
$eacute = [char]0x00E9
$euro = [char]0x20AC
$writer.WriteLine('{"type":"result","subtype":"success","is_error":false,"result":"caf' + $eacute + ' ' + $euro + ' READY"}')
$writer.Flush()
$code = 0
if ($env:CURSOR_GROK_FAKE_EXIT) { $code = [int]$env:CURSOR_GROK_FAKE_EXIT }
exit $code
'@, $utf8)

[System.IO.File]::WriteAllText($launcher, @'
$ErrorActionPreference = 'Stop'
$prompt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:CURSOR_GROK_TEST_PROMPT_B64))
$splat = @{
    Prompt = $prompt
    Mode = $env:CURSOR_GROK_TEST_MODE
    Workspace = $env:CURSOR_GROK_TEST_WS
    HeartbeatSeconds = [int]$env:CURSOR_GROK_TEST_HEARTBEAT
}
if ($env:CURSOR_GROK_TEST_WORKTREE -eq '1') {
    & $env:CURSOR_GROK_TEST_WRAPPER @splat -Worktree
} else {
    & $env:CURSOR_GROK_TEST_WRAPPER @splat
}
# exit in the called wrapper sets LASTEXITCODE and returns. -File honors only this script.
exit $LASTEXITCODE
'@, $utf8)

function New-TempRepo([string]$Path, [string]$Branch, [switch]$Detach) {
    New-Item -ItemType Directory -Path $Path | Out-Null
    & git -C $Path init --quiet
    if ($LASTEXITCODE -ne 0) { throw "git init failed ($LASTEXITCODE) $Path" }
    & git -C $Path config user.email 'cursor-grok-test@example.com'
    & git -C $Path config user.name 'cursor-grok-test'
    [System.IO.File]::WriteAllText((Join-Path $Path 'f.txt'), 'x')
    & git -C $Path add -- f.txt
    if ($LASTEXITCODE -ne 0) { throw "git add failed ($LASTEXITCODE) $Path" }
    & git -C $Path commit --quiet -m init
    if ($LASTEXITCODE -ne 0) { throw "git commit failed ($LASTEXITCODE) $Path" }
    if ($Branch) {
        & git -C $Path checkout -q -b $Branch
        if ($LASTEXITCODE -ne 0) { throw "git checkout failed ($LASTEXITCODE) $Branch" }
    }
    if ($Detach) {
        & git -C $Path checkout -q --detach HEAD
        if ($LASTEXITCODE -ne 0) { throw "git detach failed ($LASTEXITCODE) $Path" }
    }
}

function Invoke-Case {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Workspace,
        [Parameter(Mandatory)][string]$Mode,
        [Parameter(Mandatory)][string]$Prompt,
        [int]$HeartbeatSeconds = 30,
        [switch]$Worktree,
        [string]$FakeMode = 'record',
        [string]$FakeExit = ''
    )
    $capture = Join-Path $script:tmp $Name
    New-Item -ItemType Directory -Path $capture -Force | Out-Null
    $env:CURSOR_GROK_AGENT = $script:fake
    $env:CURSOR_GROK_CAPTURE = $capture
    $env:CURSOR_GROK_FAKE_MODE = $FakeMode
    $env:CURSOR_GROK_FAKE_EXIT = $FakeExit
    $env:CURSOR_GROK_TEST_WS = $Workspace
    $env:CURSOR_GROK_TEST_PROMPT_B64 = [Convert]::ToBase64String($script:utf8.GetBytes($Prompt))
    $env:CURSOR_GROK_TEST_MODE = $Mode
    $env:CURSOR_GROK_TEST_HEARTBEAT = "$HeartbeatSeconds"
    $env:CURSOR_GROK_TEST_WORKTREE = $(if ($Worktree) { '1' } else { '0' })
    $env:CURSOR_GROK_TEST_WRAPPER = $script:wrapper
    $outFile = Join-Path $capture 'stdout.bin'
    $errFile = Join-Path $capture 'stderr.bin'
    $proc = Start-Process -FilePath $script:hostExe -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script:launcher)
    $stdout = if (Test-Path -LiteralPath $outFile) { [System.IO.File]::ReadAllBytes($outFile) } else { New-Object byte[] 0 }
    $stderr = if (Test-Path -LiteralPath $errFile) { [System.IO.File]::ReadAllBytes($errFile) } else { New-Object byte[] 0 }
    $argsPath = Join-Path $capture 'args.txt'
    $stdinPath = Join-Path $capture 'stdin.bin'
    $argv = @()
    if (Test-Path -LiteralPath $argsPath) { $argv = [System.IO.File]::ReadAllLines($argsPath) }
    $stdin = New-Object byte[] 0
    if (Test-Path -LiteralPath $stdinPath) { $stdin = [System.IO.File]::ReadAllBytes($stdinPath) }
    return [pscustomobject]@{
        ExitCode = $proc.ExitCode
        Stdout = $stdout
        Stderr = $stderr
        Argv = @($argv)
        Stdin = $stdin
        ArgsWritten = (Test-Path -LiteralPath $argsPath)
        Capture = $capture
    }
}

function Stop-RecordedPids([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    Get-ChildItem -LiteralPath $Root -Recurse -Filter *.pid -ErrorAction SilentlyContinue | ForEach-Object {
        $text = [System.IO.File]::ReadAllText($_.FullName).Trim()
        $procId = 0
        if ([int]::TryParse($text, [ref]$procId) -and $procId -gt 0 -and $procId -ne $PID) {
            try { & taskkill.exe /PID $procId /T /F > $null 2> $null } catch { }
        }
    }
}

try {
    $env:CURSOR_GROK_AGENT = $fake
    $space = Join-Path $tmp 'space dir'
    New-Item -ItemType Directory -Path $space | Out-Null
    $spaceSlash = $space + '\'
    $prompt = 'say "hi"' + "`n" + 'next line'

    $ask = Invoke-Case -Name 'ask' -Workspace $spaceSlash -Mode ask -Prompt $prompt -Worktree
    $askErr = Get-StdErrText $ask.Stderr
    $askWs = Get-FlagValue $ask.Argv '--workspace'
    Assert-True ($ask.ExitCode -eq 0) "ask exit $($ask.ExitCode): $(Short-Text $askErr)"
    Assert-True $ask.ArgsWritten 'ask mode did not invoke the fake CLI'
    Assert-True ($askWs -eq $space) "workspace with spaces and trailing backslash was not normalized: got [$askWs] want [$space] argv=$($ask.Argv -join ' | ')"
    Assert-True (@($ask.Argv)[-1] -eq $space) "workspace must be the last argument: $($ask.Argv -join ' | ')"
    $resolvedInput = $null
    if (Test-Path -LiteralPath $spaceSlash) {
        $resolvedInput = (Resolve-Path -LiteralPath $spaceSlash).ProviderPath.TrimEnd('\')
    }
    Assert-True ($resolvedInput -eq $space) "input path does not resolve: [$resolvedInput]"
    Assert-True ((Get-FlagValue $ask.Argv '--mode') -eq 'ask') "ask --mode was swallowed: $($ask.Argv -join ' | ')"
    Assert-True (@($ask.Argv) -notcontains '--force') "ask must not pass --force: $($ask.Argv -join ' | ')"
    Assert-True (@($ask.Argv) -contains '--worktree') "missing --worktree: $($ask.Argv -join ' | ')"
    Assert-True (@($ask.Argv) -contains '-p') "missing -p: $($ask.Argv -join ' | ')"
    Assert-True (Test-SameBytes $ask.Stdin ($utf8.GetBytes($prompt))) "stdin prompt mismatch: [$(Get-Text $ask.Stdin)]"
    $stdoutText = Get-Text $ask.Stdout
    Assert-True ($stdoutText -match '"type"\s*:\s*"result"' -and $stdoutText -match 'READY') "stdout was not the result line: $(Short-Text $stdoutText)"
    Assert-True (Test-HasBytes $ask.Stdout ([byte[]](0xE2, 0x82, 0xAC))) "stdout lost UTF-8 euro: $(Short-Text $stdoutText)"
    Assert-True (Test-HasBytes $ask.Stdout ([byte[]](0xC3, 0xA9))) "stdout lost UTF-8 e-acute: $(Short-Text $stdoutText)"
    $noBom = ($ask.Stdout.Length -lt 3) -or -not ($ask.Stdout[0] -eq 0xEF -and $ask.Stdout[1] -eq 0xBB -and $ask.Stdout[2] -eq 0xBF)
    Assert-True $noBom 'stdout JSON starts with a UTF-8 BOM'
    Assert-True ($ask.Stdout.Length -gt 0 -and $ask.Stdout[0] -eq 0x7B) 'stdout JSON does not start with {'

    $plan = Invoke-Case -Name 'plan' -Workspace $spaceSlash -Mode plan -Prompt 'plan-me'
    $planWs = Get-FlagValue $plan.Argv '--workspace'
    Assert-True ($plan.ExitCode -eq 0) "plan exit $($plan.ExitCode): $(Short-Text (Get-StdErrText $plan.Stderr))"
    Assert-True ((Get-FlagValue $plan.Argv '--mode') -eq 'plan') "plan --mode was swallowed: $($plan.Argv -join ' | ')"
    Assert-True ($planWs -eq $space) "plan workspace was not normalized: [$planWs]"
    Assert-True (@($plan.Argv)[-1] -eq $space) "plan workspace must be the last argument: $($plan.Argv -join ' | ')"
    Assert-True (@($plan.Argv) -notcontains '--force') 'plan must not pass --force'
    Assert-True (@($plan.Argv) -notcontains '--worktree') 'plan must not pass --worktree'

    $exit3 = Invoke-Case -Name 'exit3' -Workspace $space -Mode ask -Prompt 'x' -FakeExit '3'
    Assert-True ($exit3.ExitCode -eq 3) "nonzero exit was not propagated: got $($exit3.ExitCode) $(Short-Text (Get-StdErrText $exit3.Stderr))"
    Assert-True ((Get-Text $exit3.Stdout) -match 'READY') 'nonzero exit dropped the result line'

    $empty = Invoke-Case -Name 'empty' -Workspace $space -Mode ask -Prompt 'x' -FakeMode 'empty'
    Assert-True ($empty.ExitCode -eq 1) "empty agent should exit 1, got $($empty.ExitCode)"
    Assert-True ((Get-StdErrText $empty.Stderr) -match 'no result event') "missing no-result notice: $(Short-Text (Get-StdErrText $empty.Stderr))"

    $empty5 = Invoke-Case -Name 'empty5' -Workspace $space -Mode ask -Prompt 'x' -FakeMode 'empty' -FakeExit '5'
    Assert-True ($empty5.ExitCode -eq 5) "empty nonzero exit was not propagated: got $($empty5.ExitCode) $(Short-Text (Get-StdErrText $empty5.Stderr))"

    $burst = Invoke-Case -Name 'burst' -Workspace $space -Mode ask -Prompt 'x' -FakeMode 'burst'
    $burstErr = Get-StdErrText $burst.Stderr
    Assert-True ($burst.ExitCode -eq 0) "burst exit $($burst.ExitCode): $(Short-Text $burstErr)"
    $missing = @()
    foreach ($n in 1..30) {
        if ($burstErr -notmatch ('burst-' + $n + '(\D|$)')) { $missing += $n }
    }
    Assert-True ($missing.Count -eq 0) "queued stderr was dropped: $($missing -join ',')"

    $mainRepo = Join-Path $tmp 'reject-main'
    New-TempRepo $mainRepo
    $reject = Invoke-Case -Name 'reject-main' -Workspace $mainRepo -Mode agent -Prompt 'do not write'
    Assert-True (-not $reject.ArgsWritten) 'agent mode on a non-issue branch launched the fake CLI'
    Assert-True ($reject.ExitCode -ne 0) 'agent mode on a non-issue branch should fail'
    Assert-True (Test-BranchGuard (Get-StdErrText $reject.Stderr)) "branch guard message missing: $(Short-Text (Get-StdErrText $reject.Stderr))"

    $detachRepo = Join-Path $tmp 'detach'
    New-TempRepo $detachRepo -Detach
    $detached = Invoke-Case -Name 'detach' -Workspace $detachRepo -Mode agent -Prompt 'do not write'
    $detachedErr = Get-StdErrText $detached.Stderr
    Assert-True (-not $detached.ArgsWritten) 'detached HEAD launched the fake CLI'
    Assert-True ($detached.ExitCode -ne 0) "detached HEAD should fail, got $($detached.ExitCode)"
    Assert-True (Test-BranchGuard $detachedErr) "detached HEAD guard message missing: $(Short-Text $detachedErr)"
    Assert-True ($detachedErr -notmatch 'null-valued') "detached HEAD crashed on Trim: $(Short-Text $detachedErr)"

    $acceptRepo = Join-Path $tmp 'accept'
    New-TempRepo $acceptRepo -Branch 'issue/77-synthetic'
    $accept = Invoke-Case -Name 'accept' -Workspace $acceptRepo -Mode agent -Prompt 'write in fake only'
    Assert-True $accept.ArgsWritten "accepted issue branch did not launch the fake: $(Short-Text (Get-StdErrText $accept.Stderr))"
    Assert-True ($accept.ExitCode -eq 0) "accepted exit $($accept.ExitCode): $(Short-Text (Get-StdErrText $accept.Stderr))"
    Assert-True (@($accept.Argv) -contains '--force') "agent mode missing --force: $($accept.Argv -join ' | ')"
    Assert-True (@($accept.Argv) -notcontains '--mode') "agent mode must not pass --mode: $($accept.Argv -join ' | ')"
    Assert-True (@($accept.Argv)[-1] -eq $acceptRepo) "agent workspace must be the last argument: $($accept.Argv -join ' | ')"

    $slow = Invoke-Case -Name 'slow' -Workspace $space -Mode ask -Prompt 'ping' -FakeMode 'slow' -HeartbeatSeconds 1
    $slowErr = Get-StdErrText $slow.Stderr
    Assert-True ($slow.ExitCode -eq 0) "slow exit $($slow.ExitCode): $(Short-Text $slowErr)"
    Assert-True ($slowErr -match 'cursor-grok: waiting') "missing heartbeat: $(Short-Text $slowErr)"
    Assert-True ($slowErr -match 'cursor-grok: assistant/delta') "missing progress: $(Short-Text $slowErr)"
    Assert-True ($slowErr -match 'connection lost sample') "child stderr was dropped: $(Short-Text $slowErr)"

    $treeCapture = Join-Path $tmp 'tree'
    New-Item -ItemType Directory -Path $treeCapture | Out-Null
    $treeWs = Join-Path $tmp 'tree-ws'
    New-Item -ItemType Directory -Path $treeWs | Out-Null
    $env:CURSOR_GROK_AGENT = $fake
    $env:CURSOR_GROK_CAPTURE = $treeCapture
    $env:CURSOR_GROK_FAKE_MODE = 'tree'
    $env:CURSOR_GROK_FAKE_EXIT = ''
    $env:CURSOR_GROK_TEST_WS = $treeWs
    $env:CURSOR_GROK_TEST_PROMPT_B64 = [Convert]::ToBase64String($utf8.GetBytes('tree'))
    $env:CURSOR_GROK_TEST_MODE = 'ask'
    $env:CURSOR_GROK_TEST_HEARTBEAT = '30'
    $env:CURSOR_GROK_TEST_WORKTREE = '0'
    $env:CURSOR_GROK_TEST_WRAPPER = $wrapper
    $runspace = [powershell]::Create()
    $null = $runspace.AddScript({
        param($Path)
        & $Path
    }).AddArgument($launcher)
    $handle = $runspace.BeginInvoke()
    $pidFile = Join-Path $treeCapture 'grand.pid'
    $deadline = [datetime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $pidFile) -and [datetime]::UtcNow -lt $deadline) {
        if ($handle.IsCompleted) { break }
        Start-Sleep -Milliseconds 50
    }
    $grandchild = $null
    if (Test-Path -LiteralPath $pidFile) {
        $grandchild = [int]([System.IO.File]::ReadAllText($pidFile).Trim())
    }
    $runspace.Stop()
    try { $null = $runspace.EndInvoke($handle) } catch { }
    $runspace.Dispose()
    $gone = $false
    if ($grandchild) {
        $deadline = [datetime]::UtcNow.AddSeconds(5)
        do {
            if (-not (Get-Process -Id $grandchild -ErrorAction SilentlyContinue)) { $gone = $true; break }
            Start-Sleep -Milliseconds 100
        } while ([datetime]::UtcNow -lt $deadline)
    }
    Assert-True ($null -ne $grandchild) 'interruption test never started the grandchild'
    Assert-True $gone "grandchild $grandchild still running after the wrapper was stopped"
}
finally {
    Stop-RecordedPids $tmp
    if ($null -eq $savedAgent) {
        Remove-Item Env:CURSOR_GROK_AGENT -ErrorAction SilentlyContinue
    } else {
        $env:CURSOR_GROK_AGENT = $savedAgent
    }
    foreach ($name in @(
            'CURSOR_GROK_CAPTURE', 'CURSOR_GROK_FAKE_MODE', 'CURSOR_GROK_FAKE_EXIT',
            'CURSOR_GROK_TEST_WS', 'CURSOR_GROK_TEST_PROMPT_B64', 'CURSOR_GROK_TEST_MODE',
            'CURSOR_GROK_TEST_HEARTBEAT', 'CURSOR_GROK_TEST_WORKTREE', 'CURSOR_GROK_TEST_WRAPPER'
        )) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failed.Count) {
    foreach ($item in $failed) { [Console]::Error.WriteLine($item) }
    exit 1
}
Write-Output 'cursor-grok tests passed'
exit 0
