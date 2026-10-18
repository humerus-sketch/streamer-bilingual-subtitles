"""Match wheel DLL mangling hashes to official MSYS2 packages and retain sources."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.request

import argparse
import shutil
import struct

from build_assets import digest, write_json


def fetch(url, path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=45) as source, path.open('xb') as target:
            shutil.copyfileobj(source, target, length=4 * 1024 * 1024)


def code_sections(data):
    offset = struct.unpack_from('<I', data, 0x3c)[0]
    if data[offset:offset + 4] != b'PE\0\0':
        raise RuntimeError('msys2_evidence_not_pe')
    section_count = struct.unpack_from('<H', data, offset + 6)[0]
    optional_size = struct.unpack_from('<H', data, offset + 20)[0]
    answer = {}
    for index in range(section_count):
        section = offset + 24 + optional_size + 40 * index
        name = data[section:section + 8].rstrip(b'\0').decode('ascii')
        if name in {'.text', '.rdata', '.data'}:
            size, pointer = struct.unpack_from('<II', data, section + 16)
            answer[name] = hashlib.sha256(data[pointer:pointer + size]).hexdigest()
    return answer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--av-libs', type=Path, required=True)
    args = parser.parse_args()
    output = args.assets / 'msys2-provenance'
    output.mkdir(exist_ok=True)
    target_files = {}
    for path in args.av_libs.glob('*.dll'):
        match = re.fullmatch(r'(libgcc_s_seh-1|libstdc\+\+-6|libiconv-2|libwinpthread-1|zlib1)-([0-9a-f]{32})\.dll', path.name)
        if match:
            target_files[match.group(1) + '.dll'] = {'mangledFile': path.name, 'suffix': match.group(2),
                                                    'codeSections': code_sections(path.read_bytes())}
    with urllib.request.urlopen('https://repo.msys2.org/mingw/x86_64/', timeout=30) as response:
        html = response.read().decode('utf-8')
    index = set(re.findall(r'href="([^"/]+\.pkg\.tar\.zst)"', html))
    selected = sorted(name for name in index if re.fullmatch(
        r'mingw-w64-x86_64-(?:gcc-libs-16\.1\.0-5|libiconv-1\.19-1|zlib-1\.3\.2-[12]|libwinpthread-(?:13|14)\.0\.0\.[A-Za-z0-9.]+-[12])-any\.pkg\.tar\.zst', name))
    def examine(name):
        target = output / 'binary-package-evidence' / name
        url = 'https://repo.msys2.org/mingw/x86_64/' + name
        fetch(url, target)
        content = subprocess.check_output(['tar', '-xOf', str(target), '.PKGINFO'], stderr=subprocess.DEVNULL).decode('utf-8')
        info = dict(line.split(' = ', 1) for line in content.splitlines() if ' = ' in line)
        matches = []
        for dll_name, expected in target_files.items():
            process = subprocess.run(['tar', '-xOf', str(target), 'mingw64/bin/' + dll_name], capture_output=True)
            if process.returncode:
                continue
            hashes = {'sha256Prefix': hashlib.sha256(process.stdout).hexdigest()[:32],
                      'md5': hashlib.md5(process.stdout).hexdigest()}
            sections = code_sections(process.stdout)
            suffix_matches = expected['suffix'] in hashes.values()
            # The wheel repair changes writable PE data/import bookkeeping.
            # Match both complete executable code and read-only constants.
            sections_match = all(sections.get(key) == expected['codeSections'].get(key)
                                 for key in ('.text', '.rdata'))
            if suffix_matches or sections_match:
                matches.append({'file': expected['mangledFile'], 'hashMatchesDelvewheelSuffix': suffix_matches,
                                'originalDllSha256': hashlib.sha256(process.stdout).hexdigest(),
                                'codeSections': sections, 'wheelSections': expected['codeSections'],
                                'codeAndReadOnlySectionsIdenticalAfterVendorStripAndMangling': sections_match,
                                'matchedMethod': next((key for key, value in hashes.items() if value == expected['suffix']), 'identical_text_and_rdata_sections')})
        if matches:
            print(json.dumps({'event': 'msys2_binary_matched', 'package': name, 'files': len(matches)}), flush=True)
            return {'package': name, 'url': url, 'sha256': digest(target), 'pkgbase': info['pkgbase'],
                    'pkgver': info['pkgver'], 'pkgInfo': info, 'matches': matches}
        return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        matches = [item for item in pool.map(examine, selected) if item]
    found = {item['file'] for match in matches for item in match['matches']}
    unresolved = sorted({item['mangledFile'] for item in target_files.values()} - found)
    sources = []
    for package in matches:
        name = package['pkgbase'] + '-' + package['pkgver'] + '.src.tar.zst'
        target = args.assets / 'corresponding-source/sources' / name
        url = 'https://repo.msys2.org/mingw/sources/' + name
        fetch(url, target)
        sources.append({'file': target.name, 'url': url, 'sha256': digest(target), 'bytes': target.stat().st_size,
                        'binaryPackage': package['package'], 'pkgbase': package['pkgbase'], 'pkgver': package['pkgver']})
    write_json(output / 'report.json', {'schemaVersion': 1, 'packagesChecked': len(selected),
               'binaryMatches': matches, 'sources': sources, 'unresolvedFiles': unresolved,
               'sourceAuthenticity': 'Official MSYS2 HTTPS source packages; package source contents retained; no GPG certification claimed'})
    print(json.dumps({'event': 'msys2_sources_complete', 'matchedFiles': len(found), 'unresolvedFiles': unresolved}), flush=True)


if __name__ == '__main__':
    main()
