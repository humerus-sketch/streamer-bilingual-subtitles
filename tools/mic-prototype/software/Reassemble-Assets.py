"""Reassemble the frozen Windows runtime from pinned official archives on CI.

The runner only downloads/extracts bytes. It never executes Windows binaries,
installs Python packages or rebuilds model/engine code. All resulting component
files must match the locally validated frozen inventories before packaging.
"""
from __future__ import annotations
import argparse
import base64
import concurrent.futures
from datetime import datetime, timezone
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import time
import urllib.request
import zipfile

from build_assets import digest, files, package, write_json


def safe_relative(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or '..' in path.parts or '\\' in value or ':' in value:
        raise RuntimeError('reassembly_unsafe_relative_path')
    return Path(*path.parts)


def fetch(source, cache):
    path = cache / source['id']
    if path.is_file() and path.stat().st_size == source['bytes'] and digest(path) == source['sha256']:
        return path
    for attempt in range(3):
        try:
            request = urllib.request.Request(source['url'], headers={'User-Agent': 'StreamerSubtitleByteReassembly/0.1'})
            count = 0
            with urllib.request.urlopen(request, timeout=180) as response, path.open('wb') as target:
                while data := response.read(8 * 1024 * 1024):
                    count += len(data)
                    if count > source['bytes']:
                        raise RuntimeError('reassembly_source_size_exceeded')
                    target.write(data)
            if count != source['bytes'] or digest(path) != source['sha256']:
                raise RuntimeError('reassembly_source_hash_failed:' + source['id'])
            print(json.dumps({'event': 'source_verified', 'id': source['id'], 'bytes': count}), flush=True)
            return path
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)


def materialize_source(source, items, cache, stage):
    """Open each compressed source once, including the complete stdlib tarball."""
    source_path = cache / source['id']
    by_member = {}
    for item in items:
        if item['component'] not in {'python', 'whisper-large-v3', 'speaker-campp', 'codex-cli', 'corresponding-source'}:
            raise RuntimeError('reassembly_assignment_component_invalid')
        destination = stage / item['component'] / safe_relative(item['path'])
        if destination.exists():
            raise RuntimeError('reassembly_duplicate_file_assignment')
        destination.parent.mkdir(parents=True, exist_ok=True)
        by_member.setdefault(item.get('member'), []).append((item, destination))
    found = set()
    def save_member(name, stream):
        targets = by_member[name]
        with targets[0][1].open('xb') as output:
            shutil.copyfileobj(stream, output, length=8 * 1024 * 1024)
        for _, destination in targets[1:]:
            try:
                os.link(targets[0][1], destination)
            except OSError:
                shutil.copyfile(targets[0][1], destination)
        found.add(name)
    if source['format'] == 'raw':
        if set(by_member) != {None}:
            raise RuntimeError('reassembly_raw_source_member_invalid')
        for _, destination in by_member[None]:
            try:
                os.link(source_path, destination)
            except OSError:
                shutil.copyfile(source_path, destination)
        found.add(None)
    elif source['format'] == 'zip':
        with zipfile.ZipFile(source_path) as archive:
            for name in by_member:
                with archive.open(name) as stream:
                    save_member(name, stream)
    elif source['format'] == 'tar.gz':
        with tarfile.open(source_path, 'r|gz') as archive:
            for member in archive:
                if member.name in by_member:
                    if not member.isfile():
                        raise RuntimeError('reassembly_archive_member_not_file')
                    with archive.extractfile(member) as stream:
                        save_member(member.name, stream)
    else:
        raise RuntimeError('reassembly_source_format_invalid')
    if found != set(by_member):
        raise RuntimeError('reassembly_source_members_missing')
    for item, destination in (pair for targets in by_member.values() for pair in targets):
        if item.get('patch'):
            patch = json.loads((stage / safe_relative(item['patch'])).read_text(encoding='utf-8'))
            if digest(destination) != patch['sourceFileSha256']:
                raise RuntimeError('reassembly_patch_source_hash_failed')
            with destination.open('r+b') as target:
                target.truncate(patch['targetBytes'])
                for block in patch['blocks']:
                    data = base64.b64decode(block['data'], validate=True)
                    if not isinstance(block['offset'], int) or block['offset'] < 0 or block['offset'] + len(data) > patch['targetBytes']:
                        raise RuntimeError('reassembly_patch_bounds_invalid')
                    target.seek(block['offset'])
                    target.write(data)
        if destination.stat().st_size != item['bytes'] or digest(destination) != item['sha256']:
            raise RuntimeError('reassembly_frozen_file_mismatch:' + item['component'] + '/' + item['path'])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--overlay', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding='utf-8'))
    if plan['schemaVersion'] != 1 or args.overlay.stat().st_size != plan['overlay']['bytes'] or digest(args.overlay) != plan['overlay']['sha256']:
        raise RuntimeError('reassembly_overlay_integrity_failed')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    stage, cache, release = (output / name for name in ('staging', 'source-cache', 'release-assets'))
    for path in (stage, cache, release):
        path.mkdir()
    allowed_components = {'python', 'whisper-large-v3', 'speaker-campp', 'codex-cli', 'corresponding-source'}
    if set(plan['inventories']) != allowed_components:
        raise RuntimeError('reassembly_component_set_changed')
    with zipfile.ZipFile(args.overlay) as archive:
        for info in archive.infolist():
            relative = safe_relative(info.filename)
            if relative.parts[0] not in allowed_components | {'_patches'} or info.file_size >= 2 * 1024 * 1024:
                raise RuntimeError('reassembly_overlay_entry_invalid')
        archive.extractall(stage)
    sources = {item['id']: item for item in plan['sources']}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        dict(pool.map(lambda item: (item['id'], fetch(item, cache)), sources.values()))
    grouped = {}
    for item in plan['assignments']:
        grouped.setdefault(item['source'], []).append(item)
    for source_id, items in grouped.items():
        materialize_source(sources[source_id], items, cache, stage)
        print(json.dumps({'event': 'source_members_materialized', 'id': source_id, 'files': len(items)}), flush=True)
    checks = []
    for component_id, inventory in plan['inventories'].items():
        root = stage / component_id
        actual_files = {path.relative_to(root).as_posix() for path in files(root)}
        if actual_files != {item['path'] for item in inventory}:
            raise RuntimeError('reassembly_final_file_set_mismatch:' + component_id)
        for item in inventory:
            path = root / safe_relative(item['path'])
            if path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
                raise RuntimeError('reassembly_final_frozen_hash_mismatch:' + component_id + '/' + item['path'])
        checks.append({'id': component_id, 'files': len(inventory), 'allFrozenFileHashesMatch': True,
                       'expandedBytes': sum(item['bytes'] for item in inventory)})
        print(json.dumps({'event': 'frozen_tree_verified', **checks[-1]}), flush=True)
    manifest = plan['originalManifest']
    for component in manifest['components']:
        component_id = component['id']
        original_name = component.get('fileName') or 'streamer-subtitles-whisper-large-v3-win-x64-0.1.0.zip'
        rebuilt = package(stage / component_id, release, original_name,
                          1_250_000_000 if component['format'] == 'split-zip' else 0)
        component.update(rebuilt)
    source_name = manifest['correspondingSource']['fileName']
    source_asset = package(stage / 'corresponding-source', release, source_name)
    manifest['correspondingSource'] = {key: source_asset[key] for key in ('fileName', 'bytes', 'sha256')}
    manifest['reassembledFromFrozenManifestSha256'] = plan['frozenManifestSha256']
    manifest['reassembledAt'] = datetime.now(timezone.utc).isoformat()
    write_json(release / 'components-1.json', manifest)
    names = ['components-1.json', source_name]
    for component in manifest['components']:
        names.extend([component['fileName']] if component['format'] == 'zip' else [part['name'] for part in component['parts']])
    allowlist = [{'name': name, 'bytes': (release / name).stat().st_size, 'sha256': digest(release / name)} for name in names]
    if any(item['bytes'] >= 2_000_000_000 for item in allowlist):
        raise RuntimeError('reassembled_asset_exceeds_github_limit')
    write_json(output / 'release-allowlist.json', {'schemaVersion': 1, 'files': allowlist,
               'tag': manifest['tag'], 'repository': manifest['repository'], 'totalBytes': sum(item['bytes'] for item in allowlist)})
    write_json(output / 'reassembly-report.json', {'schemaVersion': 1, 'planSha256': digest(args.plan),
               'frozenManifestSha256': plan['frozenManifestSha256'], 'components': checks,
               'allFrozenFileHashesMatch': True, 'binariesExecuted': False, 'codeOrModelsRebuilt': False,
               'rebuiltManifestSha256': digest(release / 'components-1.json'), 'allowlist': allowlist})
    print(json.dumps({'event': 'reassembly_complete', 'manifestSha256': digest(release / 'components-1.json')}), flush=True)


if __name__ == '__main__':
    main()
