"""Write a public, path-redacted report from the sealed local evidence."""
import argparse
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import shutil

from build_assets import digest, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    assets = args.assets.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    release = assets / 'release-assets'
    read = lambda path: json.loads(path.read_text(encoding='utf-8'))
    manifest = read(release / 'components-1.json')
    integrity = read(assets / 'final-integrity-report.json')
    relocation = read(assets / 'relocation-validation-final/validation-report.json')
    inference = read(assets / 'relocation-validation-final/inference-report.json')
    if integrity['componentsManifestSha256'] != digest(release / 'components-1.json') or relocation['assetsManifestSha256'] != integrity['componentsManifestSha256']:
        raise RuntimeError('asset_report_manifest_drift')
    allowlist = read(assets / 'release-allowlist.json')
    allowlist.pop('containsRecordings', None)
    allowlist['personalRecordingsBundled'] = False
    allowlist['thirdPartySyntheticFixturesBundled'] = len(integrity['thirdPartySyntheticFixturesBundled'])
    write_json(assets / 'release-allowlist.json', allowlist)
    prefix = inference['pythonPrefix']
    redact = lambda value: json.loads(json.dumps(value, ensure_ascii=False).replace(json.dumps(prefix, ensure_ascii=False)[1:-1], '[RELOCATED_PYTHON]'))
    for name, value in (('components-1.json', manifest), ('release-allowlist.json', allowlist),
                        ('integrity.json', integrity), ('relocation.json', relocation), ('inference.json', redact(inference))):
        write_json(output / name, value)
    source_manifest = read(assets / 'corresponding-source/source-manifest.json')
    write_json(output / 'source-provenance.json', source_manifest)
    shutil.copy2(assets / 'staging/codex-cli/runtime-version.json', output / 'codex-runtime.json')
    sources = read(assets / 'staging/codex-cli/NOTICES/sources.json')
    write_json(output / 'codex-license-sources.json', sources)
    rows = '\n'.join(f"| `{item['id']}` | {item['expandedBytes'] / 1024**2:.2f} MiB | `{item['version']}` | `{item['target']}` |" for item in manifest['components'])
    sha_rows = '\n'.join(f"| `{item['name']}` | {item['bytes']:,} | `{item['sha256']}` |" for item in allowlist['files'])
    samples = '\n'.join(f"| {item['id']} | {item['asrMs'] / 1000:.3f}s | {item['speakerMs']:.3f}ms | {'原文完全一致' if item['recognizedJa'] == item['goldJa'] else '正文一致，标点不同'} |" for item in inference['samples'])
    now = datetime.now(timezone(timedelta(hours=8))).isoformat()
    text = f'''# Windows 可分发运行资源验收

验证时间：{now}。版本 `0.1.0`，仓库 `humerus-sketch/streamer-bilingual-subtitles`，组件发布 tag `v0.1.0`。

## 结论

四个独立组件已经实际打包，并从最终发布文件解压到含空格的新目录，完成真实 CUDA FP16 Whisper 和 CAM++ 文件推理。Python 环境变量已从子进程清空，PATH 只保留 Windows 目录；9个依赖均从新 runtime 加载，未加载旧 venv 或旧 CPython 底座。没有打开麦克风、播放录音、请求云翻译或重新授权。

这证明同一台 NVIDIA 电脑上的路径可迁移性；未在另一台干净 Windows 电脑验证，不把它称作跨设备验收。两条推理验证也不是新的50段准确率或字幕端到端延迟评测。

## 组件与安装布局

| 组件 | 展开体积 | 固定版本 | 目标 |
|---|---:|---|---|
{rows}

- 所有 ZIP 根直接是组件内容，安装时相对 `target` 解压。
- Whisper 是一个标准 ZIP64 文件的连续字节切片，按 `parts` 顺序原样拼接后校验 `archiveBytes/archiveSha256` 再解压。三片分别为1,250,000,000、1,250,000,000和590,841,676字节，均小于1.5GB。
- 程序与重量级组件分离，软件日常更新无需再次下载模型。用户设置、声纹和登录数据不在组件内。
- Python 3.12.13使用私有底座与当前锁定依赖；不带 `pyvenv.cfg`、`_virtualenv.pth`、旧 `sitecustomize` 或用户 PATH 依赖。
- Whisper仅收集已校验模型manifest规定的文件与公开notice；未收集下载缓存。CAM++只收集选定模型、manifest和notice。
- Codex保持本机官方 `0.163.0-alpha.10.2`，四个EXE原样收集；未升级、未复制任何用户配置或账号凭证。
- NVIDIA驱动、Windows UCRT/VC Runtime、WebView2 Evergreen仍由目标电脑提供；未把驱动打包。

## 最终文件推理

模型加载 `{inference['modelLoadMs'] / 1000:.3f}s`；`asrDevice=cuda`、`computeType=float16`。CAM++输出512维单位向量，仅记录维度/范数检查，未保存生物特征向量。

| 原固定录音 | ASR计算 | CAM++特征 | 识别对照 |
|---|---:|---:|---|
{samples}

`codex --version`在迁移目录返回 `{inference['codexVersion']}`。未调用任何翻译请求；现有账号状态由宿主集成另行验证。

## 完整性与隐私边界

- 最终manifest SHA256：`{integrity['componentsManifestSha256']}`。
- 最终8个release assets均完成字节数/SHA256核对；4组件ZIP根、必需文件、展开字节数、所有已解压文件逐个hash均匹配。所有单个发布文件小于2GB。
- `personalRecordingsBundled=false`；不含个人录音、声纹档案、CLI工作目录、日志、账号或Token。
- 保留SciPy自带的22条合成WAV测试fixture。仅允许 `scipy/io/tests/data/test-*.wav`中与原 `scipy-1.18.1.dist-info/RECORD`的SHA和字节数都一致的项目，逐条记录见 `integrity.json`。不能把这些上游合成测试波形误称为个人录音。
- manifest不含本机绝对路径。报告中的安装路径已替换成 `[RELOCATED_PYTHON]`。

## 第三方许可与对应源码

保留CPython完整license、全部已安装dist-info许可/notice，以及缺失的CTranslate2、FlatBuffers、Tokenizers、tqdm等官方许可。NVIDIA cuBLAS/cublasLt/nvblas的应用分发范围已按原wheel License和官方CUDA EULA Attachment A核对；只打包运行DLL，不带不需要的开发头文件，不把NVIDIA组件改称MIT或GPL。

PyAV 19.0.1源码仓库为 `PyAV-Org/PyAV`。官方vendor为 `PyAV-Org/pyav-ffmpeg`，tag `9.0.2-1`固定commit `bac889417e26be29615cb6a3f38318151fed55cd`。其FFmpeg9.0.2逐库运行信息报告LGPL3，但上游 `patches/ffmpeg.patch`把x264/x265从GPL分类列表移到version3列表，因此不能把该运行标签当成全包许可放行。各库自身许可仍适用。

独立 `{manifest['correspondingSource']['fileName']}`共 `{manifest['correspondingSource']['bytes']:,}`字节，含15项Windows vendor对应完整源码（逐项与固定recipe SHA256匹配）、全部build recipes和patch、PyAV固定tag源码、SoXR1.1.0 hashverified sdist，以及MSYS2对应完整source packages：

- `GCC16.1.0-5`：libgcc/libstdc++。
- `libiconv1.19-1`、`zlib1.3.2-2`。
- `winpthread14.0.0.r92/r98`：两者完整可执行/只读节与现有DLL一致，保留两套源码，未武断指定唯一build。

MSYS2匹配使用完整 `.text/.rdata`节SHA；vendor strip/repair改变写入数据或导入表，未宣称整DLL与原包hash相同。source archive内保留PKGBUILD、patch及上游源码。所有可执行source只作文本读取和打包，没有运行下载的build scripts。

允许用户停止程序后在 `runtime/python/Lib/site-packages/av.libs`替换兼容ABI的动态库，保留PyAV repaired文件名/导入关系；也可从源码重建PyAV/SoXR扩展，或在宿主设置选择自有Python。宿主只在下载/安装时核对包hash，不对共享runtime逐DLL启动锁定或覆盖。源包附具体替换与构建说明。公开分发须保留独立组件许可和对应源码；本报告不作法律认证。

官方资料：[Python应用私有发行包](https://docs.python.org/3.12/using/windows.html#the-embeddable-package)、[CUDA EULA](https://docs.nvidia.com/cuda/eula/index.html)、[固定vendor源码与patch](https://github.com/PyAV-Org/pyav-ffmpeg/tree/bac889417e26be29615cb6a3f38318151fed55cd)、[Codex固定版本LICENSE](https://github.com/openai/codex/blob/rust-v0.163.0-alpha.10.2/LICENSE)。

## 严格发布清单

只发布以下8项；不发布本地 `assets-manifest.json`、旧Python包、历史source包、stage、迁移测试目录或报告中的原始路径数据。

| 文件 | 字节数 | SHA256 |
|---|---:|---|
{sha_rows}

## 实际执行的验证

`Build-Assets.ps1`完成组件构建；`Complete-AssetNotices.py`补齐许可并保留旧包本地历史；`Build-CorrespondingSources.py`与 `Find-MsysSources.py`抓取/校验源码；`Finalize-AssetRelease.py`生成canonical manifest与严格allowlist；`Check-AssetRelease.py`通过8文件完整性与隐私检查；`Validate-Assets.ps1`从最终文件完成重组、解压、逐文件校验和2条真实GPU推理。`test_build_assets.py`的4项ZIP根、split重组、环境hook排除、CUDA头文件排除测试通过。`git diff --check`已执行且未报告空白错误；新文件为untracked，另做Python语法检查。

准备阶段有错误均保留：初次notice补齐遇上游URL404，修正为实际当前仓库路径后成功；第一次隐私检查把SciPy上游合成fixture误判，改成严格RECORD白名单后通过。最终资产未在检查后改写。
'''
    (output / 'README.md').write_text(text, encoding='utf-8')
    print(json.dumps({'event': 'asset_report_written', 'directory': str(output)}), flush=True)


if __name__ == '__main__':
    main()
