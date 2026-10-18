param(
    [ValidateRange(1,65535)][int]$Port = 51718,
    [ValidateSet('codex_cli','codex_resident','siwc')][string]$TranslationProvider = 'codex_resident',
    [string]$CodexModel = 'gpt-6.1-sol',
    [ValidateSet('default','fast')][string]$CodexServiceTier = 'fast',
    [ValidateSet('full','source_only')][string]$CodexPromptStyle = 'full',
    [string]$CodexExecutable
)
$ErrorActionPreference = 'Stop'
if ($CodexPromptStyle -ne 'full' -and $TranslationProvider -ne 'codex_resident') {
    throw 'CodexPromptStyle source_only is experimental and requires TranslationProvider codex_resident.'
}
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$runtimeRoot = Join-Path $workspaceRoot '.runtime/mic-prototype'
$pythonPath = Join-Path $runtimeRoot '.venv/Scripts/python.exe'
$modelDirectory = Join-Path $runtimeRoot 'models/large-v3'
if (!(Test-Path -LiteralPath $pythonPath) -or !(Test-Path -LiteralPath (Join-Path $modelDirectory 'download-manifest.json'))) {
    throw 'Isolated environment or verified large-v3 assets are missing; see docs/麦克风最小原型验证.md.'
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$gatewayPath = Join-Path $PSScriptRoot 'gateway.mjs'
$gatewayArguments = @($gatewayPath, '--port', "$Port", '--python', $pythonPath, '--model-dir', $modelDirectory)
$gatewayArguments += @('--translation-provider', $TranslationProvider)
$gatewayArguments += @('--codex-prompt-style', $CodexPromptStyle)
if ($TranslationProvider -in @('codex_cli','codex_resident')) {
    if (!$CodexExecutable) {
        # Prefer an already-installed desktop executable. Never install, upgrade or run npm's .cmd shim.
        $desktopBin = Join-Path $env:LOCALAPPDATA 'OpenAI/Codex/bin'
        $desktopCandidates = @(Get-ChildItem -LiteralPath $desktopBin -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTimeUtc -Descending | ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
        if ($desktopCandidates.Count -gt 0) { $CodexExecutable = $desktopCandidates[0] }
        else {
            $installedExe = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($installedExe) { $CodexExecutable = $installedExe.Source }
        }
    }
    if (!$CodexExecutable -or [IO.Path]::GetExtension($CodexExecutable) -ne '.exe' -or !(Test-Path -LiteralPath $CodexExecutable -PathType Leaf)) {
        throw 'An installed official codex.exe is required. Pass -CodexExecutable with the desired existing desktop CLI executable; no installation or login changes are performed.'
    }
    $CodexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).Path
    $gatewayArguments += @('--codex-executable', $CodexExecutable)
    $gatewayArguments += @('--codex-model', $CodexModel)
    $gatewayArguments += @('--codex-service-tier', $CodexServiceTier)
    Write-Host "Translation provider: $TranslationProvider; model: $CodexModel; executable: $CodexExecutable"
}
$replayPath = Join-Path $runtimeRoot 'samples/replay-16k.wav'
if (Test-Path -LiteralPath $replayPath) { $gatewayArguments += @('--replay-file', $replayPath) }
& $nodePath @gatewayArguments
exit $LASTEXITCODE
