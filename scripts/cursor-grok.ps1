[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Prompt,

    [ValidateSet('ask', 'plan', 'agent')]
    [string]$Mode = 'ask',

    [string]$Workspace = (Get-Location).Path,

    [switch]$Worktree
)

$cursorAgent = Join-Path $env:LOCALAPPDATA 'cursor-agent\agent.ps1'
if (-not (Test-Path $cursorAgent)) {
    throw 'Cursor CLI not found. Install it from https://cursor.com/docs/cli/installation.'
}

$args = @(
    '-p',
    '--output-format', 'json',
    '--sandbox', 'disabled', # Cursor sandbox is unavailable on native Windows.
    '--trust',
    '--model', 'cursor-grok-4.6-xhigh',
    '--workspace', $Workspace
)

if ($Mode -ne 'agent') {
    $args += @('--mode', $Mode)
}
if ($Worktree) {
    $args += '--worktree'
}

& $cursorAgent @args $Prompt
exit $LASTEXITCODE
