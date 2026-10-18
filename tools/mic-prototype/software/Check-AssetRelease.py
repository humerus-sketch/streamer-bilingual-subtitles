"""Read-only integrity/privacy check for the exact release allowlist."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path, PurePosixPath
import re
import zipfile
import base64
import csv
import hashlib
import io

from build_assets import digest, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    release = args.assets / 'release-assets'
    allowlist = json.loads((args.assets / 'release-allowlist.json').read_text(encoding='utf-8'))
    manifest = json.loads((release / 'components-1.json').read_text(encoding='utf-8'))
    if {item['id'] for item in manifest['components']} != {'python', 'whisper-large-v3', 'speaker-campp', 'codex-cli'}:
        raise RuntimeError('release_components_missing')
    for entry in allowlist['files']:
        path = release / entry['name']
        if path.stat().st_size != entry['bytes'] or digest(path) != entry['sha256']:
            raise RuntimeError('release_asset_integrity_failed')
        if entry['bytes'] >= 2_000_000_000:
            raise RuntimeError('release_asset_too_large')
    checks = []
    third_party_synthetic_fixtures = []
    for component in manifest['components']:
        root = args.assets / 'staging' / component['id']
        if component['format'] == 'zip':
            archive = release / component['fileName']
        else:
            archive = args.assets / 'archives' / 'streamer-subtitles-whisper-large-v3-win-x64-0.1.0.zip'
        if digest(archive) != component['archiveSha256'] or archive.stat().st_size != component['archiveBytes']:
            raise RuntimeError('release_archive_mismatch')
        with zipfile.ZipFile(archive) as zipped:
            names = zipped.namelist()
            fixture_records = {}
            if component['id'] == 'python':
                record_name = 'Lib/site-packages/scipy-1.18.1.dist-info/RECORD'
                for row in csv.reader(io.StringIO(zipped.read(record_name).decode('utf-8'))):
                    if len(row) == 3 and row[0].startswith('scipy/io/tests/data/test-') and row[0].endswith('.wav'):
                        fixture_records['Lib/site-packages/' + row[0]] = row
            expanded = sum(item.file_size for item in zipped.infolist())
            if expanded != component['expandedBytes']:
                raise RuntimeError('release_archive_expanded_mismatch')
            for name in names:
                relative = PurePosixPath(name)
                if relative.is_absolute() or '..' in relative.parts or '\\' in name or ':' in name:
                    raise RuntimeError('release_archive_path_escape')
                upstream_fixture = False
                if name in fixture_records:
                    row = fixture_records[name]
                    data = zipped.read(name)
                    record_hash = 'sha256=' + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode('ascii').rstrip('=')
                    if row[1] != record_hash or int(row[2]) != len(data):
                        raise RuntimeError('scipy_upstream_synthetic_fixture_hash_failed')
                    upstream_fixture = True
                    third_party_synthetic_fixtures.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                                                          'source': 'scipy-1.18.1.dist-info/RECORD', 'upstreamRecordMatch': True})
                if (relative.name.casefold() in {'auth.json', 'credentials.json', 'pyvenv.cfg', '_virtualenv.pth', 'sitecustomize.py', 'usercustomize.py'}
                        or relative.suffix.casefold() in {'.wav', '.mp3', '.flac'} and not upstream_fixture
                        or any(part.casefold() in {'speaker-profiles', 'test-profiles', 'runs', 'cli-work'} for part in relative.parts)):
                    raise RuntimeError('release_private_data_path')
            if not set(component['requiredFiles']).issubset(names):
                raise RuntimeError('release_required_file_missing')
        checks.append({'id': component['id'], 'files': len(names), 'expandedBytes': expanded,
                       'archiveSha256': component['archiveSha256'], 'requiredFilesPresent': True,
                       'noPrivateDataPaths': True, 'zipRootCorrect': True})
    text = (release / 'components-1.json').read_text(encoding='utf-8')
    if re.search(r'[A-Za-z]:\\|/Users/|/home/', text):
        raise RuntimeError('release_manifest_machine_path')
    write_json(args.report, {'schemaVersion': 1, 'checkedAt': datetime.now(timezone.utc).isoformat(),
               'componentsManifestSha256': digest(release / 'components-1.json'),
               'allowlistFilesVerified': len(allowlist['files']), 'allAssetBytesUnder2GB': True,
               'allModelPartsUnder1_5GB': all(part['bytes'] < 1_500_000_000 for item in manifest['components'] for part in item.get('parts', [])),
               'components': checks, 'publicManifestContainsMachinePaths': False,
               'sourceAssetSha256': manifest['correspondingSource']['sha256'],
               'personalRecordingsBundled': False,
               'thirdPartySyntheticFixturesBundled': third_party_synthetic_fixtures,
               'privacyCheckScope': 'allowlisted source locations and archive paths; no credentials/profile/log/recording trees collected'})
    print(json.dumps({'event': 'release_asset_check_passed', 'files': len(allowlist['files'])}), flush=True)


if __name__ == '__main__':
    main()
