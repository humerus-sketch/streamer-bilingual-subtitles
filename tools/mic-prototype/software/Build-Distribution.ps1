param(
    [string]$OutputDirectory,
    [string]$Version = '0.1.0',
    [string]$Repository = 'humerus-sketch/streamer-bilingual-subtitles',
    [string]$WebView2SdkDirectory
)
$ErrorActionPreference='Stop'
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if(!$OutputDirectory){$OutputDirectory=Join-Path $sourceRoot ('.runtime/releases/'+$Version+'-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))}
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $OutputDirectory){throw 'OutputDirectory must not exist; previous releases are never overwritten.'}
if($Version -notmatch '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'){throw 'Version must be X.Y.Z.'}
New-Item -ItemType Directory -Path $OutputDirectory|Out-Null
$application=Join-Path $OutputDirectory 'application'
$buildArgs=@{OutputDirectory=$application;Distribution=$true;Version=$Version;Repository=$Repository;CodexModel='gpt-6-astra';CodexServiceTier='fast'}
if($WebView2SdkDirectory){$buildArgs.WebView2SdkDirectory=$WebView2SdkDirectory}
& (Join-Path $PSScriptRoot '../desktop/Build-Exe.ps1') @buildArgs|Out-Null
$compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$references=@('/nologo','/target:winexe','/platform:x64','/optimize+','/langversion:5','/codepage:65001',
    '/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',
    '/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll',
    ('/win32manifest:'+(Join-Path $PSScriptRoot '../desktop/Desktop.manifest')))
$core=Join-Path $PSScriptRoot 'SoftwareInstall.cs'
$assemblyInfo=Join-Path $application 'build-assembly-info.cs'
& $compiler @references ('/out:'+(Join-Path $application 'SubtitleMaintenance.exe')) '/main:BilibiliSubtitlePrototype.InstallerProgram' $core (Join-Path $PSScriptRoot 'InstallerProgram.cs') $assemblyInfo
if($LASTEXITCODE -ne 0){throw 'Maintenance helper compilation failed.'}
& $compiler @references ('/out:'+(Join-Path $application 'BilibiliSubtitleBootstrap.exe')) '/main:BilibiliSubtitlePrototype.BootstrapProgram' $core (Join-Path $PSScriptRoot 'BootstrapProgram.cs') $assemblyInfo
if($LASTEXITCODE -ne 0){throw 'Stable launcher compilation failed.'}
$utf8=New-Object System.Text.UTF8Encoding($false)
$readme=@'
主播双语字幕 Windows x64 软件版

请运行 BilibiliSubtitle-Setup.exe 安装。软件安装到当前用户，不需要管理员权限。
启动使用桌面“主播双语字幕软件版”或开始菜单“主播双语字幕”。
首次进入“软件设置与更新”下载环境和模型，也可以选择已有环境目录。
环境包括独立Python、GPU运行依赖、Whisper large-v3、CAM++与官方Codex CLI。
模型首次下载约3GiB以上，请预留至少12GiB磁盘空间（含下载、解压和旧版本）。
需要Windows 10/11 x64、.NET Framework 4.8、WebView2 Runtime及NVIDIA显卡驱动。
当前Whisper使用FP16，建议至少8GiB显存。没有符合条件GPU时不承诺可运行。
已有Codex登录会沿用；新电脑需用自己的ChatGPT账号完成一次官方CLI登录。
软件不会分发账号、Token、测试声纹或录音。

软件内“检查更新”从GitHub Releases读取新版本；“下载并安装更新”校验后停止后台、
安装到新版本目录并重启。旧版本保留，模型、用户设置、声纹和登录不随程序更新覆盖。
用户数据默认在 %LOCALAPPDATA%\BilibiliSubtitlePrototype。
程序安装在 %LOCALAPPDATA%\Programs\BilibiliSubtitle。
卸载程序文件会保留用户数据；不会删除你的Codex登录。

本版本为功能预览。既有识别缺口和翻译长尾尚未修复，不能保证三秒内双语显示。
第三方组件各有许可，详见组件包内license/notice和来源记录。EXE未购买代码签名证书。
'@
[IO.File]::WriteAllText((Join-Path $application 'README.txt'),$readme,$utf8)
$manifestPath=Join-Path $application 'package-manifest.json'
$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
$files=@(Get-ChildItem -LiteralPath $application -File -Recurse|Where-Object {$_.FullName -ne $manifestPath}|ForEach-Object{
    [ordered]@{path=$_.FullName.Substring($application.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$manifest.files=$files
[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 8),$utf8)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=Join-Path $OutputDirectory ('BilibiliSubtitle-'+$Version+'-win-x64.zip')
[IO.Compression.ZipFile]::CreateFromDirectory($application,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
$setup=Join-Path $OutputDirectory ('BilibiliSubtitle-'+$Version+'-Setup.exe')
& $compiler @references ('/out:'+$setup) '/main:BilibiliSubtitlePrototype.InstallerProgram' ('/resource:'+$zip+',app.zip') ('/resource:'+(Join-Path $application 'software-release.json')+',software-release.json') $core (Join-Path $PSScriptRoot 'InstallerProgram.cs') $assemblyInfo
if($LASTEXITCODE -ne 0){throw 'Setup EXE compilation failed.'}
$artifacts=@($zip,$setup)|ForEach-Object{[ordered]@{name=[IO.Path]::GetFileName($_);bytes=(Get-Item -LiteralPath $_).Length;sha256=(Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}}
$hashFile=Join-Path $OutputDirectory 'SHA256SUMS-app.txt'
[IO.File]::WriteAllText($hashFile,(($artifacts|ForEach-Object{$_.sha256+'  '+$_.name})-join "`n")+"`n",$utf8)
$report=[ordered]@{schemaVersion=1;version=$Version;repository=$Repository;applicationDirectory=$application;setup=$setup;appZip=$zip;credentialsBundled=$false;personalProfilesBundled=$false;runtimeAssetsSeparate=$true;artifacts=$artifacts;builtAtUtc=[DateTimeOffset]::UtcNow.ToString('o')}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'distribution-build.json'),($report|ConvertTo-Json -Depth 7),$utf8)
[pscustomobject]$report
