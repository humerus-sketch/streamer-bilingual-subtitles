param(
    [string]$OutputDirectory,
    [string]$PythonExecutable,
    [string]$ModelDirectory,
    [string]$ReplayFile,
    [string]$EnhancementAssets,
    [string]$SpeakerAssets,
    [string]$TestSpeakerProfile,
    [hashtable]$CapturedReplayFiles = @{},
    [string]$WebView2SdkDirectory,
    [string]$CodexModel = 'gpt-6.1-sol',
    [ValidateSet('default','fast')][string]$CodexServiceTier = 'fast',
    [switch]$Distribution,
    [string]$Version = '0.1.0',
    [string]$Repository = 'humerus-sketch/streamer-bilingual-subtitles'
)
$ErrorActionPreference = 'Stop'
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (!$OutputDirectory) { $OutputDirectory = Join-Path $env:LOCALAPPDATA ('BilibiliSubtitlePrototype/builds/' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'OutputDirectory must be a new directory; existing builds are never overwritten.' }
if (!$PythonExecutable) { $PythonExecutable = Join-Path $sourceRoot '.runtime/mic-prototype/.venv/Scripts/python.exe' }
if (!$ModelDirectory) { $ModelDirectory = Join-Path $sourceRoot '.runtime/mic-prototype/models/large-v3' }
if ($Distribution) {
    if ($ReplayFile -or $TestSpeakerProfile -or $EnhancementAssets -or $CapturedReplayFiles.Count -ne 0) { throw 'A distribution cannot include test recordings, speaker profiles or enhancement fixtures.' }
    $PythonExecutable = '{shared}/runtime/python/python.exe'
    $ModelDirectory = '{shared}/models/large-v3'
    $SpeakerAssets = '{shared}/models/speaker'
} else {
    $PythonExecutable = [IO.Path]::GetFullPath($PythonExecutable)
    $ModelDirectory = [IO.Path]::GetFullPath($ModelDirectory)
}
if ($Version -notmatch '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$' -or $Repository -ne 'humerus-sketch/streamer-bilingual-subtitles') { throw 'Invalid software release identity.' }
if ($ReplayFile) {
    $ReplayFile = [IO.Path]::GetFullPath($ReplayFile)
    if (!(Test-Path -LiteralPath $ReplayFile -PathType Leaf)) { throw 'ReplayFile must be an existing local test recording.' }
}
if ($EnhancementAssets) {
    $EnhancementAssets = [IO.Path]::GetFullPath($EnhancementAssets)
    if (!(Test-Path -LiteralPath $EnhancementAssets -PathType Container)) { throw 'EnhancementAssets must be an existing isolated assets directory.' }
}
if ($SpeakerAssets -and !$Distribution) {
    $SpeakerAssets = [IO.Path]::GetFullPath($SpeakerAssets)
    if (!(Test-Path -LiteralPath (Join-Path $SpeakerAssets 'manifest.json') -PathType Leaf)) { throw 'SpeakerAssets must contain the verified local speaker model manifest.' }
}
if ($TestSpeakerProfile) {
    $TestSpeakerProfile = [IO.Path]::GetFullPath($TestSpeakerProfile)
    if (!(Test-Path -LiteralPath $TestSpeakerProfile -PathType Leaf) -or !$SpeakerAssets -or $CapturedReplayFiles.Count -eq 0) { throw 'A test-only profile requires explicit local captured replays and speaker assets.' }
}
$capturedReplayCatalog = [ordered]@{}
foreach ($id in $CapturedReplayFiles.Keys) {
    if ($id -notmatch '^[A-Za-z0-9_-]{1,40}$' -or $CapturedReplayFiles[$id] -isnot [string] -or $CapturedReplayFiles[$id] -notmatch '\.wav$') { throw 'CapturedReplayFiles must map safe IDs to local WAV recordings.' }
    $capturePath = [IO.Path]::GetFullPath($CapturedReplayFiles[$id])
    if (!(Test-Path -LiteralPath $capturePath -PathType Leaf)) { throw 'A configured microphone recording does not exist.' }
    $capturedReplayCatalog[$id] = $capturePath
}
if (!$Distribution -and (!(Test-Path -LiteralPath $PythonExecutable -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $ModelDirectory 'model.bin') -PathType Leaf) -or
    !(Test-Path -LiteralPath (Join-Path $ModelDirectory 'download-manifest.json') -PathType Leaf))) { throw 'Existing verified Python environment and ASR model are required.' }
if ($CodexModel -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') { throw 'Invalid CodexModel.' }
$nodeExecutable = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'The Windows .NET Framework C# compiler is unavailable.' }
$nodeVersion = (& $nodeExecutable --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v\d+\.\d+\.\d+$') { throw 'Cannot determine the installed Node version.' }

# Pin a compatible official SDK; use the already-installed Evergreen runtime without changing it.
$webViewVersion = '1.0.3650.58'
$webViewHash = 'WDaTuak798It8pY8Y+2DG68qWZKwo5u1Ux8kDvaDiUexmsDhfqWdw1LR87YkEqdPa/14SEywVZRWzgtNoKKqqw=='
if (!$WebView2SdkDirectory) { $WebView2SdkDirectory = Join-Path $env:LOCALAPPDATA ('BilibiliSubtitlePrototype/build-cache/WebView2/' + $webViewVersion) }
New-Item -ItemType Directory -Path $WebView2SdkDirectory -Force | Out-Null
$sdkPackage = Join-Path $WebView2SdkDirectory 'sdk.nupkg'
if (!(Test-Path -LiteralPath $sdkPackage -PathType Leaf)) {
    Invoke-WebRequest -Uri ('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/' + $webViewVersion + '/microsoft.web.webview2.' + $webViewVersion + '.nupkg') -OutFile $sdkPackage -UseBasicParsing
}
$sdkHashAlgorithm = [Security.Cryptography.SHA512]::Create()
$sdkStream = [IO.File]::OpenRead($sdkPackage)
try { $actualSdkHash = [Convert]::ToBase64String($sdkHashAlgorithm.ComputeHash($sdkStream)) } finally { $sdkStream.Dispose(); $sdkHashAlgorithm.Dispose() }
if ($actualSdkHash -ne $webViewHash) { throw 'WebView2 SDK differs from the pinned official NuGet catalog hash.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sdkArchive = [IO.Compression.ZipFile]::OpenRead($sdkPackage)
try {
    foreach ($entryName in @('lib/net462/Microsoft.Web.WebView2.Core.dll','lib/net462/Microsoft.Web.WebView2.WinForms.dll','runtimes/win-x64/native/WebView2Loader.dll','LICENSE.txt')) {
        $sdkEntry = $sdkArchive.GetEntry($entryName)
        if (!$sdkEntry) { throw 'Required WebView2 SDK asset is missing.' }
        $assetPath = Join-Path $WebView2SdkDirectory $sdkEntry.Name
        if (!(Test-Path -LiteralPath $assetPath -PathType Leaf)) { [IO.Compression.ZipFileExtensions]::ExtractToFile($sdkEntry,$assetPath,$false) }
        $entryStream = $sdkEntry.Open(); $assetHasher = [Security.Cryptography.SHA256]::Create()
        try { $expectedAssetHash = [BitConverter]::ToString($assetHasher.ComputeHash($entryStream)).Replace('-','') } finally { $entryStream.Dispose(); $assetHasher.Dispose() }
        if ((Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash -ne $expectedAssetHash) { throw 'Cached WebView2 SDK asset hash mismatch.' }
    }
} finally { $sdkArchive.Dispose() }
New-Item -ItemType Directory -Path (Join-Path $OutputDirectory 'runtime') -Force | Out-Null
Copy-Item -LiteralPath $nodeExecutable -Destination (Join-Path $OutputDirectory 'runtime/node.exe')
foreach ($assembly in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll')) {
    Copy-Item -LiteralPath (Join-Path $WebView2SdkDirectory $assembly) -Destination (Join-Path $OutputDirectory $assembly)
}
Copy-Item -LiteralPath (Join-Path $WebView2SdkDirectory 'LICENSE.txt') -Destination (Join-Path $OutputDirectory 'WEBVIEW2-LICENSE.txt')

# Copy the static relative import closure only. Never copy .runtime, logins, caches or environment files.
$queue = New-Object 'System.Collections.Generic.Queue[string]'
$visited = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$queue.Enqueue((Join-Path $PSScriptRoot 'host.mjs'))
$queue.Enqueue((Join-Path $PSScriptRoot '../software/update-cli.mjs'))
$importPattern = '(?m)\b(?:import|export)\s+(?:[^;\r\n]*?\s+from\s*)?[''\"](\.[^''\"]+)[''\"]'
while ($queue.Count -gt 0) {
    $file = [IO.Path]::GetFullPath($queue.Dequeue())
    if (!$visited.Add($file)) { continue }
    $rootPrefix = $sourceRoot.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (!$file.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'A runtime import escapes the source tree or is missing.' }
    $relative = $file.Substring($rootPrefix.Length)
    $destination = Join-Path (Join-Path $OutputDirectory 'payload') $relative
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
    Copy-Item -LiteralPath $file -Destination $destination
    $source = [IO.File]::ReadAllText($file)
    foreach ($match in [regex]::Matches($source, $importPattern)) {
        $dependency = $match.Groups[1].Value
        if (!$dependency.EndsWith('.mjs')) { throw 'Review the non-mjs relative import before packaging.' }
        $queue.Enqueue([IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($file)) $dependency)))
    }
}
foreach ($asset in @('worker.py','audio_enhancement.py','speaker_admission.py','ui.html','bilingual.schema.json','translation-base.md','translation-zh.md','translation-en.md')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('../' + $asset)) -Destination (Join-Path $OutputDirectory ('payload/tools/mic-prototype/' + $asset))
}
$license = Join-Path $OutputDirectory 'runtime/NODE-LICENSE.txt'
$licenseLocal = Join-Path ([IO.Path]::GetDirectoryName($nodeExecutable)) 'LICENSE'
if (Test-Path -LiteralPath $licenseLocal -PathType Leaf) { Copy-Item -LiteralPath $licenseLocal -Destination $license }
else { Invoke-WebRequest -Uri ('https://raw.githubusercontent.com/nodejs/node/' + $nodeVersion + '/LICENSE') -OutFile $license -UseBasicParsing }
if ((Get-Item -LiteralPath $license).Length -lt 1000) { throw 'The Node license notice is missing or incomplete.' }

$settings = [ordered]@{ schemaVersion=1; pythonExecutable=$PythonExecutable; modelDirectory=$ModelDirectory;
    dataDirectory=$(if ($Distribution) { '{shared}/data' } else { Join-Path $env:LOCALAPPDATA 'BilibiliSubtitlePrototype/data' }); codexExecutable='';
    codexModel=$CodexModel; codexServiceTier=$CodexServiceTier; replayFile=$(if ($ReplayFile) { $ReplayFile } else { $null });
    enhancementAssets=$(if ($EnhancementAssets) { $EnhancementAssets } else { $null }); capturedReplayFiles=$capturedReplayCatalog;
    speakerAssets=$(if ($SpeakerAssets) { $SpeakerAssets } else { $null });
    testSpeakerProfile=$(if ($TestSpeakerProfile) { $TestSpeakerProfile } else { $null });
    residentPolicy=[ordered]@{maxCachedModels=4;maxContextBytes=131072;contextUsageThreshold=0.8;modelPolicies=@{}} }
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'launcher.settings.json'), ($settings | ConvertTo-Json -Depth 4), $utf8)
$release = [ordered]@{ schemaVersion=1;version=$Version;repository=$Repository;channel='stable';appAsset=('BilibiliSubtitle-'+$Version+'-win-x64.zip');componentsManifestAsset='components-1.json';componentsReleaseTag='v0.1.0' }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'software-release.json'), ($release|ConvertTo-Json), $utf8)
$assemblyInfo=Join-Path $OutputDirectory 'build-assembly-info.cs'
$assemblySource='using System.Reflection;'+"`n"+'[assembly: AssemblyTitle("主播双语字幕")]'+"`n"+'[assembly: AssemblyProduct("主播双语字幕")]'+"`n"+'[assembly: AssemblyCompany("humerus-sketch")]'+"`n"+'[assembly: AssemblyVersion("'+$Version+'.0")]'+"`n"+'[assembly: AssemblyFileVersion("'+$Version+'.0")]'+"`n"+'[assembly: AssemblyInformationalVersion("'+$Version+'")]'
[IO.File]::WriteAllText($assemblyInfo,$assemblySource,$utf8)
$executable = Join-Path $OutputDirectory 'BilibiliSubtitle.exe'
$compilerArgs = @('/nologo','/target:winexe','/platform:x64','/optimize+','/langversion:5','/codepage:65001',
    '/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll',
    ('/reference:' + (Join-Path $OutputDirectory 'Microsoft.Web.WebView2.Core.dll')),
    ('/reference:' + (Join-Path $OutputDirectory 'Microsoft.Web.WebView2.WinForms.dll')),
    ('/win32manifest:' + (Join-Path $PSScriptRoot 'Desktop.manifest')),
    ('/out:' + $executable), (Join-Path $PSScriptRoot 'Launcher.cs'), (Join-Path $PSScriptRoot 'DesktopWindow.cs'), (Join-Path $PSScriptRoot 'SoftwareCenter.cs'), (Join-Path $PSScriptRoot '../software/SoftwareInstall.cs'), $assemblyInfo)
& $compiler @compilerArgs
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'EXE compilation failed.' }
$readme = @'
主播双语字幕：Windows x64 桌面客户端（本机测试版）

双击 BilibiliSubtitle.exe。字幕界面直接显示在桌面窗口内，不打开外部浏览器。
选择模型和麦克风，点击“开始”才采音；启动只枚举设备，不会自动打开麦克风。
模型下拉切换对后续识别片段生效，已排队任务使用原模型完成。
原声输入，不启用增强。默认需登记本人声纹才可开始；点击登记才采音，声纹只保存在本机。
每句参考上一句已完成的中英文译文，翻译完成后一次显示完整双语。
Codex按模型复用持续会话，到轮数/上下文门槛才重建；每个新会话完整加载翻译角色规则。
收到当前上下文占用达到80%的通知就立即预建新会话，不等下一句；当前句完成后安全切换。
关闭客户端窗口会停止本次后台服务及其子进程。

请保留整个文件夹，不能只移动EXE。程序包含Node、WebView2 SDK和界面源码；
WebView2 Runtime使用Windows现有安装。Python、CUDA依赖、识别模型和Codex客户端
复用本电脑已有环境，路径见launcher.settings.json；未打包账号凭证或复制模型。
原工作区的Python环境和识别模型必须保留。本包不是跨电脑免配置安装包。
Codex登录由官方客户端管理，不改全局设置，不另外进行SIWC授权。
数据与日志使用LocalAppData/BilibiliSubtitlePrototype/data。
当前为功能测试版，真人识别/译文质量与三秒延迟需要另外验收。
--desktop-smoke-test PATH 验证真实内嵌界面而不开麦；--smoke-test PATH只验证后台启动关闭。
'@
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'README.txt'), $readme, $utf8)
$manifestFiles = @(Get-ChildItem -LiteralPath $OutputDirectory -File -Recurse | ForEach-Object {
    [ordered]@{ path=$_.FullName.Substring($OutputDirectory.Length+1).Replace('\','/'); bytes=$_.Length; sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$manifest = [ordered]@{ builtAt=(Get-Date -Format o); kind=$(if($Distribution){'windows-distribution-application'}else{'embedded-desktop-local-machine-test-build'}); version=$Version; nodeVersion=$nodeVersion; webView2SdkVersion=$webViewVersion;
    pythonBundled=$false; asrWeightsBundled=$false; codexBundled=$false; credentialsBundled=$false; files=$manifestFiles }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'package-manifest.json'), ($manifest | ConvertTo-Json -Depth 6), $utf8)
[PSCustomObject]@{Executable=$executable;BuildDirectory=$OutputDirectory;Files=$manifestFiles.Count;Bytes=($manifestFiles | Measure-Object -Property bytes -Sum).Sum}
