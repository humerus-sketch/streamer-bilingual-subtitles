function Write-ApplicationZip {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory=$true)][string]$SourceDirectory,
        [Parameter(Mandatory=$true)][string]$DestinationPath
    )
    $ErrorActionPreference='Stop'
    $source=[IO.Path]::GetFullPath($SourceDirectory)
    $destination=[IO.Path]::GetFullPath($DestinationPath)
    if(!(Test-Path -LiteralPath $source -PathType Container)){throw 'Application ZIP source directory is missing.'}
    $prefix=$source.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
    if($destination.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Application ZIP destination must be outside the source directory.'}
    if(!(Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($destination)) -PathType Container)){throw 'Application ZIP destination directory is missing.'}
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $files=@(Get-ChildItem -LiteralPath $source -File -Recurse|Sort-Object FullName)
    if($files.Count -eq 0){throw 'Application ZIP source directory is empty.'}
    # .NET Framework's CreateFromDirectory emits backslashes under Windows
    # PowerShell 5.1. Explicit entry names retain the same portable ZIP contract.
    $stream=[IO.File]::Open($destination,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $archive=$null
    try{
        $archive=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
        foreach($file in $files){
            if(!$file.FullName.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Application ZIP file escaped the source directory.'}
            $entryName=$file.FullName.Substring($prefix.Length).Replace('\','/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$entryName,[IO.Compression.CompressionLevel]::Optimal)|Out-Null
        }
        $archive.Dispose();$archive=$null
        $stream.Flush($true)
    }finally{
        if($null -ne $archive){$archive.Dispose()}
        $stream.Dispose()
    }
    [pscustomobject]@{ArchivePath=$destination;Files=$files.Count;Bytes=(Get-Item -LiteralPath $destination).Length}
}
