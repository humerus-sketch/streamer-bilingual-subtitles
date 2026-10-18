"""Extract the release artifacts at a new location, then run file-only inference.

Never opens an audio device, makes a cloud translation request or accesses login
credentials. Environment cleanup applies only to the owned child process.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

if len(sys.argv) > 1 and sys.argv[1] == '--child':
    # The isolated interpreter intentionally omits the script directory from
    # sys.path. Check that isolation before adding the copied application modules.
    def write_json(path, value):
        Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
else:
    from build_assets import digest, files, write_json


def check_archive(path, component):
    if path.stat().st_size != component['archiveBytes'] or digest(path) != component['archiveSha256']:
        raise RuntimeError('asset_archive_integrity_failed')


def parent_main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    install = output / 'standalone install with spaces'
    install.mkdir()
    release = args.assets / 'release-assets'
    manifest_file = release / 'components-1.json'
    if not manifest_file.is_file():
        manifest_file = release / 'assets-manifest.json'
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    extracts = []
    for component in manifest['components']:
        print(json.dumps({'event': 'extract', 'component': component['id']}), flush=True)
        if component['format'] == 'split-zip':
            archive = output / (component['id'] + '-joined.zip')
            with archive.open('xb') as target:
                for part in component['parts']:
                    source = release / part['name']
                    if source.stat().st_size != part['bytes'] or digest(source) != part['sha256']:
                        raise RuntimeError('asset_part_integrity_failed')
                    with source.open('rb') as stream:
                        shutil.copyfileobj(stream, target, length=8 * 1024 * 1024)
        else:
            archive = release / component['fileName']
        check_archive(archive, component)
        destination = install / component['target']
        destination.mkdir(parents=True)
        with zipfile.ZipFile(archive) as zipped:
            total = 0
            for info in zipped.infolist():
                relative = Path(info.filename)
                if (relative.is_absolute() or '..' in relative.parts or '\\' in info.filename
                        or ':' in info.filename or info.external_attr >> 16 & 0o170000 == 0o120000):
                    raise RuntimeError('asset_archive_path_invalid')
                total += info.file_size
            if total != component['expandedBytes']:
                raise RuntimeError('asset_archive_expanded_size_failed')
            zipped.extractall(destination)
        inventory = json.loads((args.assets / (component['id'] + '-files.json')).read_text(encoding='utf-8'))
        for record in inventory['files']:
            path = destination / record['path']
            if path.stat().st_size != record['bytes'] or digest(path) != record['sha256']:
                raise RuntimeError('asset_extracted_file_integrity_failed')
        if len(files(destination)) != len(inventory['files']):
            raise RuntimeError('asset_extracted_file_count_failed')
        extracts.append({'id': component['id'], 'filesVerified': len(inventory['files']),
                         'expandedBytes': total, 'archiveSha256': component['archiveSha256']})
    helpers = output / 'application-payload'
    helpers.mkdir()
    for name in ('worker.py', 'audio_enhancement.py', 'speaker_admission.py'):
        shutil.copy2(args.source_root / 'tools/mic-prototype' / name, helpers / name)
    shutil.copy2(__file__, helpers / 'validate_assets.py')
    shutil.copy2(Path(__file__).with_name('build_assets.py'), helpers / 'build_assets.py')
    source_manifest = json.loads((args.source_root / 'docs/validation/2026-10-18/session-switch-ja50-01/source-manifest.json').read_text(encoding='utf-8'))
    selected = [source_manifest['items'][index] for index in (0, 1)]
    sample_dir = output / 'test-recordings-not-for-distribution'
    sample_dir.mkdir()
    samples = []
    for item in selected:
        source = Path(item['fullClip']['file'])
        if digest(source) != item['fullClip']['sha256']:
            raise RuntimeError('asset_validation_recording_hash_failed')
        destination = sample_dir / (item['id'] + '.wav')
        shutil.copy2(source, destination)
        samples.append({'id': item['id'], 'file': str(destination), 'goldJa': item['goldJa'], 'sha256': digest(destination)})
    config = {'install': str(install), 'helpers': str(helpers), 'samples': samples,
              'forbiddenPrefixes': [str(args.source_root / '.runtime/mic-prototype'), sys.base_prefix]}
    config_file = output / 'probe-input.json'
    write_json(config_file, config)
    environment = {key: value for key, value in os.environ.items()
                   if not key.upper().startswith(('PYTHON', 'CUDA', 'CUDNN', 'VIRTUAL_ENV'))}
    environment.update(PATH=os.pathsep.join([str(Path(os.environ['WINDIR']) / 'System32'), os.environ['WINDIR']]),
                       HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_DATASETS_OFFLINE='1')
    command = [str(install / 'runtime/python/python.exe'), '-I', str(helpers / 'validate_assets.py'),
               '--child', str(config_file), str(output / 'inference-report.json')]
    with (output / 'inference-stdout.log').open('w', encoding='utf-8') as stdout, (output / 'inference-stderr.log').open('w', encoding='utf-8') as stderr:
        process = subprocess.run(command, cwd=output, env=environment, stdout=stdout, stderr=stderr, timeout=240)
    write_json(output / 'validation-report.json', {'schemaVersion': 1, 'completedAt': datetime.now(timezone.utc).isoformat(),
               'assetsManifestSha256': digest(manifest_file), 'extraction': extracts,
               'childExitCode': process.returncode, 'pythonEnvironmentCleared': True, 'pathContainsOnlyWindows': True,
               'microphoneOpened': False, 'audioPlayback': False, 'cloudTranslationRequested': False,
               'originalRuntimeUnmodified': True, 'credentialsRead': False})
    if process.returncode:
        raise RuntimeError('relocated_inference_failed')
    print(json.dumps({'event': 'validation_complete', 'report': str(output / 'validation-report.json')}), flush=True)


def child_main(config_file, report_file):
    import importlib
    import math
    import site
    import time
    import wave

    config = json.loads(Path(config_file).read_text(encoding='utf-8'))
    install = Path(config['install']).resolve()
    runtime = install / 'runtime/python'
    if Path(sys.prefix).resolve() != runtime or Path(sys.base_prefix).resolve() != runtime:
        raise RuntimeError('relocated_python_prefix_invalid')
    initial_paths = list(sys.path)
    if any(not Path(path).resolve().is_relative_to(runtime) for path in initial_paths):
        raise RuntimeError('relocated_python_sys_path_escape')
    sys.path.insert(0, config['helpers'])
    import worker
    dll_directories = worker.configure_cuda_dlls()
    imports = {}
    for name in ('numpy', 'scipy', 'sounddevice', 'soxr', 'av', 'onnxruntime', 'ctranslate2', 'faster_whisper', 'kaldi_native_fbank'):
        module = importlib.import_module(name)
        path = Path(module.__file__).resolve()
        if not path.is_relative_to(runtime):
            raise RuntimeError('relocated_import_outside_runtime:' + name)
        imports[name] = str(path.relative_to(runtime))
    import ctranslate2
    import numpy as np
    import soxr
    from speaker_admission import _SpeakerEmbedding
    cuda_count = ctranslate2.get_cuda_device_count()
    if cuda_count < 1:
        raise RuntimeError('relocated_cuda_device_unavailable')
    started = time.perf_counter()
    model = worker.load_whisper(str(install / 'models/large-v3'), 'float16')
    model_load_ms = (time.perf_counter() - started) * 1000
    speaker = _SpeakerEmbedding(install / 'models/speaker')
    results = []
    for sample in config['samples']:
        with wave.open(sample['file'], 'rb') as recording:
            if recording.getsampwidth() != 4 or recording.getnchannels() != 1:
                raise RuntimeError('relocated_fixture_encoding_invalid')
            audio = np.frombuffer(recording.readframes(recording.getnframes()), dtype='<i4').astype(np.float32) / np.float32(2147483648.0)
            sample_rate = recording.getframerate()
        if sample_rate != 16000:
            audio = soxr.resample(audio, sample_rate, 16000).astype(np.float32)
        started = time.perf_counter()
        text, metadata = worker.transcribe_audio(model, audio)
        asr_ms = (time.perf_counter() - started) * 1000
        if not text or metadata['language'] != 'ja':
            raise RuntimeError('relocated_asr_empty_or_wrong_language')
        started = time.perf_counter()
        vector = speaker.embedding(audio)
        speaker_ms = (time.perf_counter() - started) * 1000
        if vector.shape != (512,) or not math.isclose(float(np.linalg.norm(vector)), 1.0, abs_tol=1e-5):
            raise RuntimeError('relocated_speaker_embedding_invalid')
        # Embeddings are biometric data. Persist only dimension/norm checks, never vectors.
        results.append({'id': sample['id'], 'fixtureSha256': sample['sha256'], 'goldJa': sample['goldJa'],
                        'recognizedJa': text, 'asrMs': round(asr_ms, 3), 'speakerMs': round(speaker_ms, 3),
                        'embeddingDimension': 512, 'unitEmbeddingValid': True})
        print(json.dumps({'event': 'file_inference_completed', 'id': sample['id'], 'asrMs': round(asr_ms, 3)}), flush=True)
    forbidden = [str(Path(prefix).resolve()).casefold() for prefix in config['forbiddenPrefixes']]
    loaded_outside = []
    for module in list(sys.modules.values()):
        path = getattr(module, '__file__', None)
        if path and any(str(Path(path).resolve()).casefold().startswith(prefix) for prefix in forbidden):
            loaded_outside.append(getattr(module, '__name__', '?'))
    if loaded_outside:
        raise RuntimeError('relocated_old_runtime_module_loaded')
    codex = install / 'runtime/codex/codex.exe'
    version = subprocess.check_output([str(codex), '--version'], text=True, timeout=20).strip()
    write_json(report_file, {'schemaVersion': 1, 'pythonVersion': sys.version.split()[0], 'pythonPrefix': str(runtime),
               'sysPath': initial_paths, 'sitePackages': site.getsitepackages(), 'imports': imports,
               'dllDirectories': dll_directories, 'cudaDeviceCount': cuda_count, 'computeType': 'float16',
               'modelLoadMs': round(model_load_ms, 3), 'asrDevice': 'cuda', 'codexVersion': version,
               'samples': results, 'oldRuntimeModulesLoaded': loaded_outside, 'accountAccessed': False,
               'qualityScope': 'two original files verify relocation/inference, not a new 50-item accuracy benchmark'})


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--child':
        child_main(sys.argv[2], sys.argv[3])
    else:
        parent_main()
