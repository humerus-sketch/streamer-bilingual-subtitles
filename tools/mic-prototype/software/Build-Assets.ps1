param(
    [string]$OutputDirectory,
    [string]$PythonExecutable,
    [string]$ModelDirectory,
    [string]$SpeakerAssets,
    [string]$CodexExecutable,
    [string]$Repository = 'humerus-sketch/streamer-bilingual-subtitles',
    [string]$Version = '0.1.0',
    [long]$PartBytes = 1250000000
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (!$OutputDirectory) { $OutputDirectory = Join-Path $sourceRoot '.runtime/software-assets-20261018' }
if (!$PythonExecutable) { $PythonExecutable = Join-Path $sourceRoot '.runtime/mic-prototype/.venv/Scripts/python.exe' }
if (!$ModelDirectory) { $ModelDirectory = Join-Path $sourceRoot '.runtime/mic-prototype/models/large-v3' }
if (!$SpeakerAssets) { $SpeakerAssets = Join-Path $sourceRoot '.runtime/speaker-admission-20261018' }
if (!$CodexExecutable) { $CodexExecutable = (Get-Command codex.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
$arguments = @((Join-Path $PSScriptRoot 'build_assets.py'), '--output', [IO.Path]::GetFullPath($OutputDirectory),
    '--model', [IO.Path]::GetFullPath($ModelDirectory), '--speaker', [IO.Path]::GetFullPath($SpeakerAssets),
    '--codex', [IO.Path]::GetFullPath($CodexExecutable), '--repository', $Repository, '--version', $Version, '--part-bytes', $PartBytes)
& $PythonExecutable @arguments
if ($LASTEXITCODE -ne 0) { throw 'Asset build failed; preserve its output for diagnosis and use a new output directory for a retry.' }
