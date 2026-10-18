"""Preserve fixed upstream recipes and hash-verified sources for bundled media DLLs.

This does not run fetched code or certify legal compliance. In particular, the
vendor FFmpeg patch changes GPL classification labels for x264/x265; retain the
patch and individual licenses rather than treating its LGPL label as clearance.
"""
import argparse
import ast
import concurrent.futures
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import tarfile
import urllib.request
import zipfile

from build_assets import digest, fetch_notice, package, write_json

VENDOR_COMMIT = 'bac889417e26be29615cb6a3f38318151fed55cd'
VENDOR_REPO = 'PyAV-Org/pyav-ffmpeg'


def fetch(url, destination):
    if destination.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={'User-Agent': 'StreamerSubtitleSourceArchive/0.1'})
    with urllib.request.urlopen(request, timeout=90) as source, destination.open('xb') as target:
        shutil.copyfileobj(source, target, length=4 * 1024 * 1024)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True, type=Path)
    args = parser.parse_args()
    assets = args.assets.resolve()
    root = assets / 'corresponding-source'
    root.mkdir(exist_ok=True)
    recipes = root / 'recipes'
    recipes.mkdir(exist_ok=True)
    base = f'https://raw.githubusercontent.com/{VENDOR_REPO}/{VENDOR_COMMIT}/'
    tree_url = f'https://api.github.com/repos/{VENDOR_REPO}/git/trees/{VENDOR_COMMIT}?recursive=1'
    with urllib.request.urlopen(urllib.request.Request(tree_url, headers={'User-Agent': 'StreamerSubtitleSourceArchive/0.1'}), timeout=30) as response:
        tree = json.load(response)
    recipe_records = []
    for item in tree['tree']:
        if item['type'] == 'blob':
            relative = Path('pyav-ffmpeg') / item['path']
            destination = recipes / relative
            fetch(base + item['path'], destination)
            recipe_records.append({'file': relative.as_posix(), 'url': base + item['path'],
                                    'bytes': destination.stat().st_size, 'sha256': digest(destination)})
    # Read constants only. Never import or execute the downloaded upstream build code.
    parsed = ast.parse((recipes / 'pyav-ffmpeg/scripts/pkg.py').read_text(encoding='utf-8'))
    selected = {'lamer', 'opus', 'dav1d', 'libsvtav1', 'vpx', 'png', 'webp', 'libvmaf',
                'x264', 'x265', 'nv-codec-headers', 'amf-headers', 'libvpl', 'nasm', 'ffmpeg'}
    packages = []
    for node in ast.walk(parsed):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'Package':
            values = {}
            for keyword in node.keywords:
                if keyword.arg in {'name', 'source_url', 'sha256', 'source_filename'}:
                    values[keyword.arg] = ast.literal_eval(keyword.value)
            if values.get('name') in selected:
                packages.append(values)
    if {item['name'] for item in packages} != selected:
        raise RuntimeError('corresponding_source_recipe_changed')
    source_dir = root / 'sources'
    source_dir.mkdir(exist_ok=True)
    def download(item):
        name = item.get('source_filename') or item['source_url'].split('/')[-1]
        target = source_dir / name
        fetch(item['source_url'], target)
        actual = digest(target)
        if actual != item['sha256']:
            raise RuntimeError('corresponding_source_hash_mismatch:' + item['name'])
        result = {'id': item['name'], 'file': 'sources/' + name, 'url': item['source_url'],
                  'bytes': target.stat().st_size, 'sha256': actual, 'sha256MatchesVendorRecipe': True}
        print(json.dumps({'event': 'source_verified', 'id': item['name'], 'bytes': result['bytes']}), flush=True)
        return result
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        package_records = list(pool.map(download, packages))
    # The exact PyAV version source provides wheel build/fetch-vendor recipes.
    pyav_url = 'https://api.github.com/repos/PyAV-Org/PyAV/git/ref/tags/v19.0.1'
    with urllib.request.urlopen(urllib.request.Request(pyav_url, headers={'User-Agent': 'StreamerSubtitleSourceArchive/0.1'}), timeout=30) as response:
        pyav_ref = json.load(response)
    pyav_commit = pyav_ref['object']['sha']
    pyav_source_url = 'https://codeload.github.com/PyAV-Org/PyAV/tar.gz/' + pyav_commit
    pyav_archive = source_dir / ('pyav-19.0.1-' + pyav_commit + '.tar.gz')
    fetch(pyav_source_url, pyav_archive)
    pyav_record = {'id': 'pyav', 'version': '19.0.1', 'commit': pyav_commit, 'file': 'sources/' + pyav_archive.name,
                  'url': pyav_source_url, 'bytes': pyav_archive.stat().st_size, 'sha256': digest(pyav_archive)}
    # SoXR is statically included in the Python extension; preserve the full sdist
    # whose SHA256 is advertised by the package index for the installed version.
    with urllib.request.urlopen('https://pypi.org/pypi/soxr/1.1.0/json', timeout=30) as response:
        soxr_index = json.load(response)
    soxr_source = next(item for item in soxr_index['urls'] if item['packagetype'] == 'sdist')
    soxr_archive = source_dir / soxr_source['filename']
    fetch(soxr_source['url'], soxr_archive)
    if digest(soxr_archive) != soxr_source['digests']['sha256']:
        raise RuntimeError('soxr_corresponding_source_hash_failed')
    soxr_record = {'id': 'python-soxr', 'version': '1.1.0', 'file': 'sources/' + soxr_archive.name,
                   'url': soxr_source['url'], 'bytes': soxr_archive.stat().st_size, 'sha256': digest(soxr_archive),
                   'sha256MatchesPackageIndex': True}
    records = package_records + [pyav_record, soxr_record]
    # Extract only notices as text, keeping source archives untouched and retained.
    extracted_notices = []
    for record in records:
        with tarfile.open(root / record['file']) as archive:
            for member in archive.getmembers():
                if (member.isfile() and member.size < 2_000_000
                        and any(word in Path(member.name).name.casefold() for word in ('copying', 'license', 'notice'))):
                    data = archive.extractfile(member).read()
                    safe_name = member.name.replace('/', '__').replace('\\', '__')
                    target = root / 'exact-source-notices' / record['id'] / safe_name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    extracted_notices.append({'source': record['id'], 'sourceMember': member.name,
                                               'file': target.relative_to(root).as_posix(), 'sha256': digest(target)})
    write_json(root / 'source-manifest.json', {'schemaVersion': 1, 'createdAt': datetime.now(timezone.utc).isoformat(),
               'vendor': {'repository': VENDOR_REPO, 'tag': '9.0.2-1', 'commit': VENDOR_COMMIT},
               'recipes': recipe_records, 'sources': records, 'exactSourceNotices': extracted_notices,
               'unresolved': ['MSYS2-provided libgcc/libstdc++/libiconv/libwinpthread/zlib exact source revisions require mapping to wheel build environment',
                              'x264/x265 GPL or alternate licensing obligations are not resolved by vendor FFmpeg classification patch'],
               'legalClearanceCertified': False, 'vendorBinariesRebuilt': False})
    (root / 'README.txt').write_text(
        'Corresponding source and build-recipe evidence for the unmodified bundled media libraries.\n'
        'Recipes are fixed to pyav-ffmpeg commit ' + VENDOR_COMMIT + ' (release 9.0.2-1).\n'
        'Every codec source archive is verified against that exact recipe SHA256.\n'
        'PyAV source is fixed to the installed v19.0.1 tag commit; Python-SoXR 1.1.0 uses its hash-verified sdist.\n'
        'Build instructions: see recipes/pyav-ffmpeg/.github/workflows/build-ffmpeg.yml,\n'
        'scripts/build-ffmpeg.py, scripts/cibuildpkg.py, scripts/pkg.py, and every patches/*.patch.\n'
        'The vendor FFmpeg patch reclassifies x264/x265; individual component licenses remain applicable.\n'
        'See source-manifest.json unresolved entries before claiming public redistribution clearance.\n', encoding='utf-8')
    name = 'streamer-subtitles-corresponding-source-0.1.0.zip'
    archive_meta = package(root, assets / 'release-assets', name)
    write_json(assets / 'corresponding-source-report.json', {'asset': archive_meta,
               'vendorCommit': VENDOR_COMMIT, 'codecSourcesHashVerified': len(package_records),
               'legalClearanceCertified': False, 'sourceManifestSha256': digest(root / 'source-manifest.json')})
    print(json.dumps({'event': 'sources_complete', 'asset': name}), flush=True)


if __name__ == '__main__':
    main()
