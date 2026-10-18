"""Prepare a small overlay and pinned plan for byte-identical remote reassembly.

Never modifies the frozen release assets. Downloads public official artifacts for
provenance verification; no repository/release mutation or credentials are used.
"""
from __future__ import annotations
import argparse
import base64
import concurrent.futures
import csv
import hashlib
import io
import json
from pathlib import Path
import shutil
import tarfile
import urllib.request
import zipfile

from packaging.tags import parse_tag, sys_tags
from build_assets import digest, files, write_json


def fetch_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'StreamerSubtitleReassembly/0.1'})
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)


def download(url, path, expected):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url, headers={'User-Agent': 'StreamerSubtitleReassembly/0.1'})
        with urllib.request.urlopen(request, timeout=180) as source, path.open('xb') as target:
            shutil.copyfileobj(source, target, length=8 * 1024 * 1024)
    if digest(path) != expected:
        raise RuntimeError('reassembly_source_download_hash_failed:' + path.name)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    assets, output = args.assets.resolve(), args.output.resolve()
    output.mkdir(exist_ok=True, parents=True)
    cache, overlay_root = output / 'source-cache', output / 'overlay'
    cache.mkdir(exist_ok=True)
    overlay_root.mkdir(exist_ok=True)
    manifest = json.loads((assets / 'release-assets/components-1.json').read_text(encoding='utf-8'))
    components = {item['id']: {'files': json.loads((assets / (item['id'] + '-files.json')).read_text(encoding='utf-8'))['files'],
                              'sourceRoot': assets / 'staging' / item['id']} for item in manifest['components']}
    source_root = assets / 'corresponding-source'
    components['corresponding-source'] = {'sourceRoot': source_root,
        'files': [{'path': path.relative_to(source_root).as_posix(), 'bytes': path.stat().st_size,
                   'sha256': digest(path)} for path in files(source_root)]}
    large = []
    overlay_files = []
    for component_id, spec in components.items():
        for record in spec['files']:
            source = spec['sourceRoot'] / record['path']
            if source.stat().st_size != record['bytes'] or digest(source) != record['sha256']:
                raise RuntimeError('frozen_stage_drift')
            item = {'component': component_id, **record}
            if record['bytes'] < 2 * 1024 * 1024:
                target = overlay_root / component_id / record['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                overlay_files.append(item)
            else:
                large.append(item)
    sources, assignments = [], []
    # Map big package files to their original distribution RECORD ownership/hash.
    site = assets / 'staging/python/Lib/site-packages'
    ownership = {}
    wheel_specs = {}
    ordered_tags = {str(tag): index for index, tag in enumerate(sys_tags())}
    for info in site.glob('*.dist-info'):
        from email.parser import Parser
        metadata = Parser().parsestr((info / 'METADATA').read_text(encoding='utf-8'))
        for row in csv.reader(io.StringIO((info / 'RECORD').read_text(encoding='utf-8'))):
            if len(row) == 3 and row[1].startswith('sha256='):
                ownership['Lib/site-packages/' + row[0]] = (metadata['Name'], metadata['Version'], row[1])
    package_items = {}
    for item in large:
        owner = ownership.get(item['path']) if item['component'] == 'python' else None
        if owner:
            name, version, record_hash = owner
            frozen_hash = 'sha256=' + base64.urlsafe_b64encode(bytes.fromhex(item['sha256'])).decode('ascii').rstrip('=')
            if record_hash != frozen_hash:
                raise RuntimeError('frozen_binary_differs_from_distribution_record:' + item['path'])
            package_items.setdefault((name, version), []).append(item)
    def resolve_wheel(spec):
        (name, version), members = spec
        metadata = fetch_json('https://pypi.org/pypi/' + name + '/' + version + '/json')
        matches = []
        for entry in metadata['urls']:
            if entry['packagetype'] != 'bdist_wheel':
                continue
            fields = entry['filename'][:-4].rsplit('-', 3)
            tags = parse_tag('-'.join(fields[-3:]))
            ranks = [ordered_tags[str(tag)] for tag in tags if str(tag) in ordered_tags]
            if ranks:
                matches.append((min(ranks), entry))
        if not matches:
            raise RuntimeError('compatible_official_wheel_missing:' + name)
        entry = min(matches, key=lambda pair: pair[0])[1]
        source_id = 'wheel-' + name.lower().replace('_', '-')
        source = {'id': source_id, 'url': entry['url'], 'format': 'zip', 'bytes': entry['size'],
                  'sha256': entry['digests']['sha256'], 'provenance': 'PyPI exact installed version and compatible Windows wheel'}
        mapping = [{**item, 'source': source_id, 'member': item['path'].removeprefix('Lib/site-packages/')} for item in members]
        return source, mapping
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for source, mapping in pool.map(resolve_wheel, package_items.items()):
            sources.append(source)
            assignments.extend(mapping)
    print(json.dumps({'event': 'wheel_mappings_ready', 'packages': len(package_items),
                      'largeFiles': len(assignments)}), flush=True)
    # The installed uv base's BUILD file pins the official standalone release.
    py_release = fetch_json('https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20260510')
    py_name = 'cpython-3.12.13+20260510-x86_64-pc-windows-msvc-install_only_stripped.tar.gz'
    py_asset = next(entry for entry in py_release['assets'] if entry['name'] == py_name)
    py_source = {'id': 'cpython-standalone', 'url': py_asset['browser_download_url'], 'format': 'tar.gz',
                 'bytes': py_asset['size'], 'sha256': py_asset['digest'].removeprefix('sha256:')}
    py_archive = cache / 'cpython.tar.gz'
    download(py_source['url'], py_archive, py_source['sha256'])
    sources.append(py_source)
    mapped = {(item['component'], item['path']) for item in assignments}
    with tarfile.open(py_archive, 'r:gz') as archive:
        for item in large:
            if item['component'] != 'python' or (item['component'], item['path']) in mapped:
                continue
            member = 'python/' + item['path']
            data = archive.extractfile(member).read()
            if len(data) != item['bytes'] or sha(data) != item['sha256']:
                raise RuntimeError('standalone_python_binary_differs:' + item['path'])
            assignments.append({**item, 'source': py_source['id'], 'member': member})
    # Fixed model repositories, never latest/main for model binary bytes.
    for whisper in (item for item in large if item['component'] == 'whisper-large-v3'):
        model_source = {'id': 'whisper-' + whisper['path'].replace('.', '-'), 'format': 'raw',
                        'bytes': whisper['bytes'], 'sha256': whisper['sha256'],
                        'url': 'https://huggingface.co/Systran/faster-whisper-large-v3/resolve/edaa852ec7e145841d8ffdb056a99866b5f0a478/' + whisper['path']}
        sources.append(model_source)
        assignments.append({**whisper, 'source': model_source['id']})
    speaker = next(item for item in large if item['component'] == 'speaker-campp')
    # Resolve immutable repo revision, verify actual binary hash before use remotely.
    speaker_info = fetch_json('https://huggingface.co/api/models/Wespeaker/wespeaker-voxceleb-campplus')
    speaker_revision = speaker_info['sha']
    speaker_source = {'id': 'speaker-model', 'format': 'raw', 'bytes': speaker['bytes'], 'sha256': speaker['sha256'],
                      'url': 'https://huggingface.co/Wespeaker/wespeaker-voxceleb-campplus/resolve/' + speaker_revision + '/voxceleb_CAM++.onnx'}
    sources.append(speaker_source)
    assignments.append({**speaker, 'source': speaker_source['id']})
    # Upstream release signing may differ from the desktop copy. Preserve exact
    # frozen executable bytes using a bounded sparse overlay, never use a new CLI.
    codex_release = fetch_json('https://api.github.com/repos/openai/codex/releases/tags/rust-v0.163.0-alpha.10.2')
    codex_items = [item for item in large if item['component'] == 'codex-cli']
    def map_codex(item):
        stem = Path(item['path']).stem
        name = stem + '-x86_64-pc-windows-msvc.exe.tar.gz'
        asset = next(entry for entry in codex_release['assets'] if entry['name'] == name)
        source_id = 'official-' + stem
        source = {'id': source_id, 'url': asset['browser_download_url'], 'format': 'tar.gz',
                  'bytes': asset['size'], 'sha256': asset['digest'].removeprefix('sha256:')}
        archive_path = cache / name
        download(source['url'], archive_path, source['sha256'])
        with tarfile.open(archive_path, 'r:gz') as archive:
            member = next(entry for entry in archive.getmembers() if entry.isfile() and entry.name.endswith('.exe'))
            original = archive.extractfile(member).read()
        frozen = (assets / 'staging/codex-cli' / item['path']).read_bytes()
        blocks = []
        # Small fixed chunks bound the overlay, and frozen output hash prevents
        # applying it to another official build or silently changing semantics.
        for offset in range(0, len(frozen), 4096):
            block = frozen[offset:offset + 4096]
            if original[offset:offset + len(block)] != block:
                blocks.append({'offset': offset, 'data': base64.b64encode(block).decode('ascii')})
        patch = {'sourceFileSha256': sha(original), 'targetBytes': len(frozen), 'targetSha256': item['sha256'], 'blocks': blocks}
        patch_path = overlay_root / '_patches' / (stem + '.json')
        patch_path.parent.mkdir(exist_ok=True)
        write_json(patch_path, patch)
        if patch_path.stat().st_size > 2_000_000:
            raise RuntimeError('codex_diff_too_large_for_small_overlay:' + stem)
        print(json.dumps({'event': 'codex_patch_ready', 'file': stem, 'changedBlocks': len(blocks), 'patchBytes': patch_path.stat().st_size}), flush=True)
        return source, {**item, 'source': source_id, 'member': member.name, 'patch': '_patches/' + stem + '.json'}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for source, mapping in pool.map(map_codex, codex_items):
            sources.append(source)
            assignments.append(mapping)
    # Large corresponding-source inputs already have exact pinned download URLs.
    source_manifest = json.loads((source_root / 'source-manifest.json').read_text(encoding='utf-8'))
    source_urls = {item['file']: item['url'] for item in source_manifest['sources']}
    source_urls.update({'sources/' + item['file']: item['url'] for item in source_manifest['msys2Sources']})
    for item in large:
        if item['component'] != 'corresponding-source':
            continue
        source_id = 'corresponding-' + str(len(sources))
        source = {'id': source_id, 'url': source_urls[item['path']], 'format': 'raw', 'bytes': item['bytes'], 'sha256': item['sha256']}
        sources.append(source)
        assignments.append({**item, 'source': source_id})
    keys = {(item['component'], item['path']) for item in assignments}
    if keys != {(item['component'], item['path']) for item in large}:
        write_json(output / 'mapping-error.json', {'missing': sorted({(item['component'], item['path']) for item in large} - keys),
                                                  'extra': sorted(keys - {(item['component'], item['path']) for item in large})})
        raise RuntimeError('reassembly_unmapped_large_file')
    overlay_path = output / 'reassembly-overlay.zip'
    with zipfile.ZipFile(overlay_path, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        for path in files(overlay_root):
            archive.write(path, path.relative_to(overlay_root).as_posix())
    plan = {'schemaVersion': 1, 'frozenManifestSha256': digest(assets / 'release-assets/components-1.json'),
            'originalManifest': manifest, 'overlay': {'fileName': overlay_path.name, 'bytes': overlay_path.stat().st_size, 'sha256': digest(overlay_path)},
            'inventories': {name: spec['files'] for name, spec in components.items()},
            'sources': sources, 'assignments': assignments,
            'provenance': 'Whole component trees must exactly match frozen per-file SHA256; wrapper ZIP hashes may differ'}
    write_json(output / 'reassembly-plan.json', plan)
    print(json.dumps({'event': 'reassembly_prepared', 'overlayBytes': overlay_path.stat().st_size,
                      'sources': len(sources), 'assignments': len(assignments)}), flush=True)


if __name__ == '__main__':
    main()
