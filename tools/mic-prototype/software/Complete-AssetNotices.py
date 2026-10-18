"""Complete notices in a new build without touching the user's source runtime.

The original ZIP and manifests remain in a local history directory; no files are
deleted. Inference code is unchanged; the resulting asset needs hash validation.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil

from build_assets import complete_runtime_notices, digest, files, package, write_json

parser = argparse.ArgumentParser()
parser.add_argument('--assets', required=True, type=Path)
parser.add_argument('--revision', default='1', choices=['1', '2', '3'])
args = parser.parse_args()
assets = args.assets.resolve()
release = assets / 'release-assets'
manifest_file = release / 'assets-manifest.json'
manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
component = next(item for item in manifest['components'] if item['id'] == 'python')
root = assets / 'staging/python'
complete_runtime_notices(root)
history = assets / ('before-notice-completion' + ('' if args.revision == '1' else '-' + args.revision))
history.mkdir(exist_ok=False)
shutil.copy2(manifest_file, history / 'assets-manifest.json')
shutil.copy2(assets / 'python-files.json', history / 'python-files.json')
new_name = 'streamer-subtitles-python-win-x64-' + manifest['releaseVersion'] + '-notices' + args.revision + '.zip'
metadata = package(root, release, new_name)
records = [{'path': path.relative_to(root).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)} for path in files(root)]
write_json(assets / 'python-files.json', {'schemaVersion': 1, 'id': 'python', 'files': records})
old_name = component['fileName']
component.update(metadata)
manifest['noticeCompletedAt'] = datetime.now(timezone.utc).isoformat()
write_json(manifest_file, manifest)
# Only a newly generated file in this build is moved; original source/model/user
# data and existing releases are untouched. Preserve it instead of deleting it.
source = release / old_name
destination = history / old_name
if not source.resolve().is_relative_to(release.resolve()) or destination.exists():
    raise RuntimeError('notice_history_path_invalid')
shutil.move(source, destination)
write_json(assets / 'notice-completion-report.json', {'schemaVersion': 1, 'licenseOnlyChanges': True,
           'manifestSha256': digest(manifest_file), 'pythonArchive': component,
           'publicSourceCorrespondenceVerified': False})
print(json.dumps({'event': 'notices_complete', 'manifest': str(manifest_file)}), flush=True)
