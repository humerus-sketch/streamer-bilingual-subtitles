"""Build immutable, credential-free assets from an already verified local runtime.

ZIP roots are the component contents, relative to manifest.target. split-zip parts
are consecutive raw byte ranges of one standard ZIP; concatenate before extraction.
No installer, user profile, microphone, network login or global setting is touched.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from email.parser import Parser
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def files(root):
    return sorted((path for path in Path(root).rglob('*') if path.is_file()),
                  key=lambda path: path.relative_to(root).as_posix().casefold())


def copy_tree(source, destination, *, base=False):
    source, destination = Path(source), Path(destination)
    for path in files(source):
        relative = path.relative_to(source)
        if (any(part in {'__pycache__', '.git', '.cache'} for part in relative.parts)
                or path.suffix in {'.pyc', '.pyo', '.pth'}
                or path.name in {'pyvenv.cfg', 'sitecustomize.py', 'usercustomize.py',
                                 '_virtualenv.py', 'direct_url.json'}
                # CUDA's application redistribution list includes these runtime
                # DLLs, not the development headers shipped by the wheel.
                or relative.parts[:3] == ('nvidia', 'cublas', 'include')
                or base and relative.parts[0].casefold() == 'site-packages'):
            continue
        if path.is_symlink():
            raise RuntimeError('asset_symlink_not_allowed')
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def fetch_notice(destination, name, url):
    # Public upstream license/card files only. Never send credentials or use user downloads.
    request = urllib.request.Request(url, headers={'User-Agent': 'StreamerSubtitleAssetBuilder/0.1'})
    with urllib.request.urlopen(request, timeout=45) as response:
        data = response.read(2_000_000)
    if len(data) < 20:
        raise RuntimeError('license_notice_download_invalid')
    path = destination / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {'file': name, 'url': url, 'bytes': len(data), 'sha256': digest(path)}


def complete_runtime_notices(py_root):
    """Preserve upstream notices missing from installed wheel metadata.

    FFmpeg exposes its exact library licenses/build flags at runtime. Keep that
    evidence rather than guessing the aggregate license from bundled DLL names.
    The source catalog states what is verified and what still needs matching to
    the vendor build before a distributor claims full source compliance.
    """
    notices = py_root / 'THIRD-PARTY-NOTICES'
    supplemental = []
    urls = (
        ('flatbuffers-Apache-2.0.txt', 'https://raw.githubusercontent.com/google/flatbuffers/v25.12.19/LICENSE'),
        ('tokenizers-Apache-2.0.txt', 'https://raw.githubusercontent.com/huggingface/tokenizers/v0.23.3/LICENSE'),
        ('tqdm-MIT-MPL.txt', 'https://raw.githubusercontent.com/tqdm/tqdm/v4.70.1/LICENCE'),
        ('FFmpeg-LGPL-3.0.txt', 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.LGPLv3'),
        ('FFmpeg-GPL-3.0.txt', 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.GPLv3'),
        ('FFmpeg-LGPL-2.1.txt', 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.LGPLv2.1'),
        ('FFmpeg-GPL-2.0.txt', 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0.2/COPYING.GPLv2'),
        ('x264-COPYING.txt', 'https://code.videolan.org/videolan/x264/-/raw/master/COPYING'),
        ('x265-COPYING.txt', 'https://raw.githubusercontent.com/videolan/x265/master/COPYING'),
        ('dav1d-COPYING.txt', 'https://code.videolan.org/videolan/dav1d/-/raw/master/COPYING'),
        ('opus-COPYING.txt', 'https://raw.githubusercontent.com/xiph/opus/main/COPYING'),
        ('libvpx-LICENSE.txt', 'https://raw.githubusercontent.com/webmproject/libvpx/main/LICENSE'),
        ('libvpx-PATENTS.txt', 'https://raw.githubusercontent.com/webmproject/libvpx/main/PATENTS'),
        ('libwebp-COPYING.txt', 'https://raw.githubusercontent.com/webmproject/libwebp/main/COPYING'),
        ('libwebp-PATENTS.txt', 'https://raw.githubusercontent.com/webmproject/libwebp/main/PATENTS'),
        ('SVT-AV1-LICENSE.txt', 'https://raw.githubusercontent.com/AOMediaCodec/SVT-AV1/master/LICENSE.md'),
        ('libvmaf-LICENSE.txt', 'https://raw.githubusercontent.com/Netflix/vmaf/master/LICENSE'),
        ('libvpl-LICENSE.txt', 'https://raw.githubusercontent.com/intel/libvpl/main/LICENSE'),
        ('zlib-LICENSE.txt', 'https://raw.githubusercontent.com/madler/zlib/develop/LICENSE'),
        ('libiconv-LGPL-2.1.txt', 'https://raw.githubusercontent.com/roboticslibrary/libiconv/master/COPYING.LIB'),
        ('GCC-runtime-COPYING3.txt', 'https://raw.githubusercontent.com/gcc-mirror/gcc/master/COPYING3'),
        ('GCC-runtime-exception.txt', 'https://raw.githubusercontent.com/gcc-mirror/gcc/master/COPYING.RUNTIME'),
        ('mingw-w64-CRT-COPYING.txt', 'https://raw.githubusercontent.com/mingw-w64/mingw-w64/master/COPYING.MinGW-w64/COPYING.MinGW-w64.txt'),
        ('mingw-w64-winpthreads-COPYING.txt', 'https://raw.githubusercontent.com/mingw-w64/mingw-w64/master/mingw-w64-libraries/winpthreads/COPYING'),
    )
    for name, url in urls:
        supplemental.append(fetch_notice(notices, name, url))
    import av
    vendor_meta = {'pyavVersion': av.__version__, 'ffmpegVersion': av.ffmpeg_version_info,
                   'libraries': av._core.library_meta,
                   'bundledLibraries': [path.name for path in files(py_root / 'Lib/site-packages/av.libs')]}
    write_json(notices / 'FFmpeg-build-metadata.json', vendor_meta)
    write_json(notices / 'supplemental-sources.json', supplemental)
    (notices / 'SOURCE-AVAILABILITY.txt').write_text(
        'Private runtime notice and source catalog. Unmodified dynamically linked libraries remain replaceable.\n'
        'Python-SoXR 1.1.0 source: https://github.com/dofuuz/python-soxr/tree/v1.1.0\n'
        'PyAV 19.0.1 source: https://github.com/PyAV-Org/PyAV/tree/v19.0.1\n'
        'FFmpeg 9.0.2 source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz\n'
        'Bundled third-party library projects and license sources are listed in supplemental-sources.json.\n'
        'The local vendor FFmpeg build reports LGPL version 3 or later; individual x264/x265 libraries\n'
        'have their own terms. Upstream license snapshots do not certify their exact vendor source revisions.\n'
        'Before public redistribution, preserve corresponding source/build scripts for the actual\n'
        'vendor DLL revisions and provide required source access/offers.\n'
        'The matching source/build package for this software release is distributed beside this runtime:\n'
        'https://github.com/humerus-sketch/streamer-bilingual-subtitles/releases/download/v0.1.0/streamer-subtitles-corresponding-source-0.1.0-complete.zip\n'
        'See that archive source-manifest.json for exact pinned sources and all vendor patches.\n'
        'The vendor patches/ffmpeg.patch reclassifies x264/x265; their individual GPL/alternate terms\n'
        'remain applicable and the FFmpeg LGPL label must not be treated as blanket license clearance.\n'
        'Dynamic library replacement is allowed: stop the application and replace the matching ABI DLLs\n'
        'under Lib/site-packages/av.libs, retaining the repaired filenames/import ABI expected by PyAV.\n'
        'For static Python-SoXR/libsoxr changes, rebuild its extension from the included sdist/build files\n'
        'and replace the Python extension. No application integrity lock prevents such replacement.\n', encoding='utf-8')
    return supplemental


def package(root, release, name, split_bytes=0):
    entries = files(root)
    archive = release.parent / 'archives' / name if split_bytes else release / name
    archive.parent.mkdir(parents=True, exist_ok=True)
    # Models are already dense binary tensors. Store them to avoid costly redundant
    # CPU compression; use fast DEFLATE for Python DLLs and source packages.
    compression = zipfile.ZIP_STORED if split_bytes else zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(archive, 'x', compression=compression,
                         compresslevel=1 if not split_bytes else None, allowZip64=True) as zipped:
        for path in entries:
            info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = compression
            info.external_attr = 0o100644 << 16
            with path.open('rb') as source, zipped.open(info, 'w', force_zip64=True) as target:
                shutil.copyfileobj(source, target, length=8 * 1024 * 1024)
    result = {'format': 'split-zip' if split_bytes else 'zip', 'archiveBytes': archive.stat().st_size,
              'archiveSha256': digest(archive), 'expandedBytes': sum(path.stat().st_size for path in entries)}
    if not split_bytes:
        result.update(fileName=name, bytes=archive.stat().st_size, sha256=result['archiveSha256'])
    else:
        parts = []
        with archive.open('rb') as source:
            index = 1
            while source.tell() < result['archiveBytes']:
                part_name = f'{name}.part{index:03}'
                path = release / part_name
                remaining = split_bytes
                with path.open('xb') as target:
                    while remaining:
                        chunk = source.read(min(8 * 1024 * 1024, remaining))
                        if not chunk:
                            break
                        target.write(chunk)
                        remaining -= len(chunk)
                parts.append({'name': part_name, 'bytes': path.stat().st_size, 'sha256': digest(path)})
                index += 1
        result['parts'] = parts
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--speaker', required=True, type=Path)
    parser.add_argument('--codex', required=True, type=Path)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--part-bytes', type=int, default=1_250_000_000)
    args = parser.parse_args()
    if (not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository)
            or not re.fullmatch(r'\d+\.\d+\.\d+', args.version)
            or not 1_000_000 <= args.part_bytes < 1_500_000_000):
        raise RuntimeError('asset_build_arguments_invalid')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    release = output / 'release-assets'
    release.mkdir()
    stage = output / 'staging'
    stage.mkdir()
    py_root, model_root, speaker_root, codex_root = (stage / item for item in ('python', 'whisper-large-v3', 'speaker-campp', 'codex-cli'))
    for path in (py_root, model_root, speaker_root, codex_root):
        path.mkdir()
    base = Path(sys.base_prefix)
    site = Path(sys.prefix) / 'Lib' / 'site-packages'
    if sys.version_info[:3] != (3, 12, 13) or not (site / 'faster_whisper').is_dir():
        raise RuntimeError('asset_build_requires_existing_pinned_python')
    print(json.dumps({'event': 'copy_python', 'python': sys.version.split()[0]}), flush=True)
    for name in ('python.exe', 'pythonw.exe', 'python3.dll', 'python312.dll', 'vcruntime140.dll',
                 'vcruntime140_1.dll', 'LICENSE.txt'):
        shutil.copy2(base / name, py_root / name)
    copy_tree(base / 'Lib', py_root / 'Lib', base=True)
    copy_tree(base / 'DLLs', py_root / 'DLLs')
    copy_tree(site, py_root / 'Lib' / 'site-packages')
    # Isolate package/module lookup from registry, user site and PYTHON* environment.
    # `import site` keeps site.getsitepackages() valid for the worker's private
    # NVIDIA DLL configuration; no .pth files or customizers are distributed.
    (py_root / 'python312._pth').write_text('Lib\nDLLs\nLib/site-packages\n.\nimport site\n', encoding='utf-8')
    notices = py_root / 'THIRD-PARTY-NOTICES'
    notices.mkdir()
    distributions = []
    for info in sorted((py_root / 'Lib' / 'site-packages').glob('*.dist-info')):
        metadata = Parser().parsestr((info / 'METADATA').read_text(encoding='utf-8'))
        notice_files = [path.relative_to(py_root).as_posix() for path in files(info)
                        if re.search(r'license|copying|notice|authors', path.name, re.I)]
        distributions.append({'name': metadata['Name'], 'version': metadata['Version'],
                              'license': metadata.get('License-Expression') or metadata.get('License'),
                              'noticeFiles': notice_files})
    upstream = []
    for name, url in (
        ('faster-whisper-MIT.txt', 'https://raw.githubusercontent.com/SYSTRAN/faster-whisper/v1.2.1/LICENSE'),
        ('CTranslate2-MIT.txt', 'https://raw.githubusercontent.com/OpenNMT/CTranslate2/v4.8.3/LICENSE'),
        ('sounddevice-MIT.txt', 'https://raw.githubusercontent.com/spatialaudio/python-sounddevice/0.5.6/LICENSE'),
        ('onnxruntime-MIT.txt', 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.31.0/LICENSE'),
        ('NVIDIA-CUDA-EULA.html', 'https://docs.nvidia.com/cuda/eula/index.html'),
        ('NVIDIA-cuDNN-EULA.html', 'https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/eula.html'),
    ):
        upstream.append(fetch_notice(notices, name, url))
    write_json(notices / 'inventory.json', {'schemaVersion': 1, 'distributions': distributions,
                                          'upstreamNotices': upstream})
    (notices / 'README.txt').write_text(
        'This private runtime is only for Streamer Bilingual Subtitles. Preserve all package license files.\n'
        'NVIDIA CUDA cuBLAS/cublasLt/nvblas are application redistributables under the supplied CUDA EULA;\n'
        'the runtime is not a standalone NVIDIA SDK and is for NVIDIA GPU systems only.\n'
        'NVIDIA driver, Microsoft UCRT/VC Runtime and WebView2 Evergreen are external prerequisites.\n'
        'SoXR is LGPL-2.1-or-later. PyAV bundles FFmpeg; see their supplied license/notice/source information.\n'
        'No upstream package license is replaced by the application license.\n', encoding='utf-8')
    complete_runtime_notices(py_root)
    print(json.dumps({'event': 'copy_models'}), flush=True)
    manifest = json.loads((args.model / 'download-manifest.json').read_text(encoding='utf-8-sig'))
    expected_names = {'config.json', 'model.bin', 'preprocessor_config.json', 'tokenizer.json', 'vocabulary.json'}
    if {entry['file'] for entry in manifest['files']} != expected_names:
        raise RuntimeError('asr_model_allowlist_changed')
    for entry in manifest['files']:
        source = args.model / entry['file']
        if source.stat().st_size != entry['bytes'] or digest(source) != entry['sha256']:
            raise RuntimeError('asr_source_integrity_failed')
        shutil.copy2(source, model_root / entry['file'])
    shutil.copy2(args.model / 'download-manifest.json', model_root / 'download-manifest.json')
    model_notices = model_root / 'NOTICES'
    model_notices.mkdir()
    model_cards = [fetch_notice(model_notices, 'model-card.md', 'https://huggingface.co/Systran/faster-whisper-large-v3/raw/main/README.md'),
                   fetch_notice(model_notices, 'Whisper-MIT.txt', 'https://raw.githubusercontent.com/openai/whisper/main/LICENSE')]
    write_json(model_notices / 'sources.json', model_cards)
    speaker_manifest = json.loads((args.speaker / 'manifest.json').read_text(encoding='utf-8-sig'))
    source = args.speaker / speaker_manifest['file']
    if (speaker_manifest.get('modelId') != 'campplus' or speaker_manifest['file'] != 'models/voxceleb_CAM++.onnx'
            or source.stat().st_size != speaker_manifest['sizeBytes'] or digest(source) != speaker_manifest['sha256']):
        raise RuntimeError('speaker_source_integrity_failed')
    (speaker_root / 'models').mkdir()
    shutil.copy2(source, speaker_root / speaker_manifest['file'])
    shutil.copy2(args.speaker / 'manifest.json', speaker_root / 'manifest.json')
    speaker_notices = speaker_root / 'NOTICES'
    speaker_notices.mkdir()
    speaker_cards = [fetch_notice(speaker_notices, 'WeSpeaker-Apache-2.0.txt', 'https://raw.githubusercontent.com/wenet-e2e/wespeaker/master/LICENSE'),
                     fetch_notice(speaker_notices, 'model-card.md', 'https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus/raw/main/README.md')]
    write_json(speaker_notices / 'sources.json', speaker_cards)
    (speaker_notices / 'MODEL-LICENSE-NOTE.txt').write_text(
        'Source: https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus\n'
        'The Hugging Face card declares Apache-2.0. The WeSpeaker toolkit license also says\n'
        'that the license of pretrained models follows the corresponding dataset.\n'
        'Preserve both upstream statements; this package does not grant additional dataset rights.\n', encoding='utf-8')
    codex_version_output = subprocess.check_output([str(args.codex), '--version'], text=True, timeout=20).strip()
    match = re.fullmatch(r'codex-cli ([A-Za-z0-9._-]+)', codex_version_output)
    if not match:
        raise RuntimeError('codex_version_invalid')
    codex_version = match.group(1)
    codex_executables = ['codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
    for name in codex_executables:
        shutil.copy2(args.codex.parent / name, codex_root / name)
    codex_notices = codex_root / 'NOTICES'
    codex_notices.mkdir()
    codex_sources = [fetch_notice(codex_notices, name + '.txt',
                                  'https://raw.githubusercontent.com/openai/codex/rust-v' + codex_version + '/' + name)
                     for name in ('LICENSE', 'NOTICE')]
    write_json(codex_notices / 'sources.json', codex_sources)
    write_json(codex_root / 'runtime-version.json', {'version': codex_version, 'source': 'official desktop bundled CLI',
               'files': [{'file': name, 'bytes': (codex_root / name).stat().st_size,
                          'sha256': digest(codex_root / name)} for name in codex_executables],
               'credentialsBundled': False})
    specs = [
        ('python', py_root, '3.12.13-win-x64-pinned-20261018', 'runtime/python',
         ['python.exe', 'python312.dll', 'python312._pth', 'Lib/site-packages/faster_whisper/__init__.py',
          'Lib/site-packages/ctranslate2/ctranslate2.dll', 'Lib/site-packages/kaldi_native_fbank/__init__.py']),
        ('whisper-large-v3', model_root, manifest['revision'], 'models/large-v3', sorted(expected_names | {'download-manifest.json'})),
        ('speaker-campp', speaker_root, speaker_manifest['sha256'], 'models/speaker', ['manifest.json', speaker_manifest['file']]),
        ('codex-cli', codex_root, codex_version, 'runtime/codex', ['codex.exe', 'runtime-version.json', 'NOTICES/LICENSE.txt', 'NOTICES/NOTICE.txt']),
    ]
    components, inventories = [], []
    for component_id, root, version, target, required in specs:
        for relative in required:
            if not (root / relative).is_file():
                raise RuntimeError('asset_required_file_missing:' + relative)
        records = [{'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)}
                   for path in files(root)]
        inventory_name = component_id + '-files.json'
        write_json(output / inventory_name, {'schemaVersion': 1, 'id': component_id, 'files': records})
        inventories.append({'id': component_id, 'file': inventory_name, 'files': len(records), 'bytes': sum(item['bytes'] for item in records)})
        print(json.dumps({'event': 'package', 'component': component_id, 'expandedBytes': sum(item['bytes'] for item in records)}), flush=True)
        archive_name = f'streamer-subtitles-{component_id}-win-x64-{args.version}.zip'
        archive_meta = package(root, release, archive_name, args.part_bytes if component_id == 'whisper-large-v3' else 0)
        components.append({'id': component_id, 'version': version, 'target': target,
                           'requiredFiles': required, **archive_meta})
    result = {'schemaVersion': 1, 'releaseVersion': args.version, 'repository': args.repository,
              'tag': 'v' + args.version, 'createdAt': datetime.now(timezone.utc).isoformat(),
              'archiveRoot': 'component-contents-relative-to-target', 'splitZipJoin': 'concatenate-parts-in-listed-order',
              'components': components}
    write_json(release / 'assets-manifest.json', result)
    write_json(output / 'build-report.json', {'schemaVersion': 1, 'completedAt': datetime.now(timezone.utc).isoformat(),
                                             'inventories': inventories, 'credentialsBundled': False,
                                             'recordingsBundled': False, 'profilesBundled': False,
                                             'runtimeSource': {'pythonVersion': sys.version.split()[0], 'venvCopied': False}})
    print(json.dumps({'event': 'complete', 'manifest': str(release / 'assets-manifest.json')}), flush=True)


if __name__ == '__main__':
    main()
