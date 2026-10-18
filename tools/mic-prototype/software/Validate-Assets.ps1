param(
    [string]$AssetsDirectory,
    [string]$OutputDirectory,
    [string]$PythonExecutable
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (!$AssetsDirectory) { $AssetsDirectory = Join-Path $sourceRoot '.runtime/software-assets-20261018' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $AssetsDirectory 'relocation-validation-01' }
if (!$PythonExecutable) { $PythonExecutable = Join-Path $sourceRoot '.runtime/mic-prototype/.venv/Scripts/python.exe' }
& $PythonExecutable (Join-Path $PSScriptRoot 'validate_assets.py') --assets ([IO.Path]::GetFullPath($AssetsDirectory)) --output ([IO.Path]::GetFullPath($OutputDirectory)) --source-root $sourceRoot
if ($LASTEXITCODE -ne 0) { throw 'Asset relocation validation failed; inspect its preserved report and logs.' }
