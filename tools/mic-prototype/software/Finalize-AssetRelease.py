"""Seal canonical components-1.json and a strict release allowlist after validation."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil

from build_assets import digest, package, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', required=True, type=Path)
    args = parser.parse_args()
    assets = args.assets.resolve()
    release = assets / 'release-assets'
    msys = json.loads((assets / 'msys2-provenance/report.json').read_text(encoding='utf-8'))
    if msys['unresolvedFiles']:
        raise RuntimeError('msys2_sources_still_unresolved')
    source_root = assets / 'corresponding-source'
    source_manifest_path = source_root / 'source-manifest.json'
    source_manifest = json.loads(source_manifest_path.read_text(encoding='utf-8'))
    shutil.copy2(assets / 'msys2-provenance/report.json', source_root / 'MSYS2-provenance.json')
    source_manifest['msys2Sources'] = msys['sources']
    source_manifest['unresolved'] = []
    source_manifest['licenseRestrictions'] = [
        'Individual x264/x265 GPL/alternate licensing remains applicable despite vendor FFmpeg classification patch',
        'NVIDIA proprietary DLL terms apply separately and are not relicensed under GPL/LGPL',
        'libwinpthread r92/r98 have identical matched executable/read-only sections; both complete source packages retained']
    source_manifest['sourceCorrespondence'] = '15 exact vendor recipe SHA256 matches; PyAV fixed tag commit; SoXR exact sdist; five MSYS2 DLL code/read-only section mappings with complete source packages'
    source_manifest['sourcePreparedAt'] = datetime.now(timezone.utc).isoformat()
    write_json(source_manifest_path, source_manifest)
    with (source_root / 'README.txt').open('a', encoding='utf-8') as stream:
        stream.write(
            '\nMSYS2 COMPLETE SOURCES\n'
            'See MSYS2-provenance.json: libgcc/libstdc++ GCC16.1.0-5, libiconv1.19-1,\n'
            'zlib1.3.2-2, libwinpthread14.0.0.r92/r98. Complete .src.tar.zst files include\n'
            'upstream source archives, PKGBUILD, patches and package build instructions.\n'
            'Both winpthread variants are retained because their executable/read-only sections match.\n'
            'The matching method compares entire .text/.rdata sections, since vendor strip/repair\n'
            'changes writable PE bookkeeping; this is not a claim of identical whole-DLL file hashes.\n'
            '\nREPLACING DYNAMIC LIBRARIES\n'
            'Stop the application, rebuild compatible FFmpeg/codec libraries using the retained recipes,\n'
            'and replace the DLLs in runtime/python/Lib/site-packages/av.libs. Keep the installed repaired\n'
            'filenames/import ABI or rebuild/repair the PyAV extension against the new DLLs.\n'
            'The application does not enforce runtime-file hashes after installation to prevent replacement.\n'
            'For Python-SoXR, rebuild its extension from the complete supplied sdist (including libsoxr)\n'
            'and replace its .pyd. Runtime updates may replace bundled libraries; retain your local build.\n'
            '\nLICENSE BOUNDARIES\n'
            'All individual upstream licenses apply. The vendor FFmpeg patch changes GPL classification\n'
            'labels for x264/x265, not their independent legal rights. The included source/build package\n'
            'and licensing terms must remain available beside the binaries. No legal certification is claimed.\n')
    source_name = 'streamer-subtitles-corresponding-source-0.1.0-complete.zip'
    source_asset = package(source_root, release, source_name)
    history = assets / 'source-history'
    history.mkdir(exist_ok=False)
    old_source = release / 'streamer-subtitles-corresponding-source-0.1.0.zip'
    if old_source.is_file():
        if not old_source.resolve().is_relative_to(release.resolve()):
            raise RuntimeError('source_history_path_invalid')
        shutil.move(old_source, history / old_source.name)
    manifest = json.loads((release / 'assets-manifest.json').read_text(encoding='utf-8'))
    manifest['correspondingSource'] = {'fileName': source_name, 'bytes': source_asset['bytes'],
                                      'sha256': source_asset['sha256']}
    write_json(release / 'components-1.json', manifest)
    names = ['components-1.json', source_name]
    for component in manifest['components']:
        names += ([component['fileName']] if component['format'] == 'zip'
                  else [part['name'] for part in component['parts']])
    allowlist = [{'name': name, 'bytes': (release / name).stat().st_size, 'sha256': digest(release / name)} for name in names]
    write_json(assets / 'release-allowlist.json', {'schemaVersion': 1, 'repository': manifest['repository'],
               'tag': manifest['tag'], 'files': allowlist, 'totalBytes': sum(item['bytes'] for item in allowlist),
               'localOnlyExcluded': ['assets-manifest.json', 'all local build/relocation/source-history folders'],
               'containsCredentials': False, 'personalRecordingsBundled': False,
               'thirdPartySyntheticFixturesBundled': 'SciPy io/tests/data upstream synthetic WAVs retained with original RECORD hashes',
               'containsSpeakerProfiles': False})
    print(json.dumps({'event': 'release_assets_sealed', 'assets': len(allowlist),
                      'componentsManifestSha256': digest(release / 'components-1.json')}), flush=True)


if __name__ == '__main__':
    main()
