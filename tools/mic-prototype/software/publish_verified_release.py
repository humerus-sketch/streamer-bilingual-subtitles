"""Publish only exact verified files; GitHub auth stays in the runner's gh process."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time


def gh(*args, capture=True):
    result = subprocess.run(['gh', *args], check=True, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--notes', required=True, type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    inventory = json.loads((output / 'publish-inventory.json').read_text(encoding='utf-8'))
    if inventory.get('locallyTestedBinariesByteIdentical') is not True or inventory.get('allComponentFilesFrozenHashVerified') is not True:
        raise RuntimeError('release_verification_required')
    repository, tag = inventory['repository'], inventory['tag']
    if os.environ.get('GH_REPO') != repository or repository != 'humerus-sketch/streamer-bilingual-subtitles':
        raise RuntimeError('release_repository_mismatch')
    existing = subprocess.run(['gh', 'release', 'view', tag, '--repo', repository, '--json', 'isDraft'],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if existing.returncode == 0:
        if not json.loads(existing.stdout).get('isDraft'):
            raise RuntimeError('published_release_is_immutable_for_this_job')
    else:
        gh('release', 'create', tag, '--repo', repository, '--target', os.environ['RELEASE_TARGET'], '--draft',
           '--title', '主播双语字幕 0.1.0', '--notes-file', str(args.notes), capture=False)
    release = json.loads(gh('api', f'repos/{repository}/releases/tags/{tag}'))
    uploaded = {asset['name']: asset for asset in release['assets']}
    for record in inventory['files']:
        present = uploaded.get(record['name'])
        expected = 'sha256:' + record['sha256']
        if present:
            if present.get('state') != 'uploaded' or present.get('size') != record['bytes'] or present.get('digest') != expected:
                raise RuntimeError('existing_draft_asset_conflict_preserved')
            continue
        gh('release', 'upload', tag, '--repo', repository, str(output / 'release-assets' / record['name']), capture=False)
        print(json.dumps({'event': 'release_asset_uploaded', 'name': record['name']}), flush=True)
    verified = False
    for _ in range(30):
        release = json.loads(gh('api', f'repos/{repository}/releases/tags/{tag}'))
        uploaded = {asset['name']: asset for asset in release['assets']}
        verified = len(uploaded) == len(inventory['files']) and all(
            record['name'] in uploaded and uploaded[record['name']].get('state') == 'uploaded'
            and uploaded[record['name']].get('size') == record['bytes']
            and uploaded[record['name']].get('digest') == 'sha256:' + record['sha256']
            for record in inventory['files'])
        if verified:
            break
        time.sleep(2)
    if not verified:
        raise RuntimeError('uploaded_release_digest_verification_failed')
    publish = os.environ.get('PUBLISH_RELEASE', '').lower() == 'true'
    if publish:
        gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--latest', capture=False)
    report = {'schemaVersion': 1, 'repository': repository, 'tag': tag, 'assetsVerified': len(inventory['files']),
              'published': publish, 'releaseUrl': f'https://github.com/{repository}/releases/tag/{tag}'}
    (output / 'publish-result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'event': 'release_verified', **report}), flush=True)


if __name__ == '__main__':
    main()
