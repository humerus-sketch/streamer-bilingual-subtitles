"""Join hash-verified resources with the exact locally tested Windows binaries."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seed', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    seed, output = args.seed.resolve(), args.output.resolve()
    proof = json.loads((output / 'reassembly-report.json').read_text(encoding='utf-8'))
    if proof.get('allFrozenFileHashesMatch') is not True or proof.get('binariesExecuted') is not False:
        raise RuntimeError('reassembly_proof_failed')
    binaries = json.loads((seed / 'verified-app.json').read_text(encoding='utf-8-sig'))
    inventory = json.loads((output / 'release-allowlist.json').read_text(encoding='utf-8'))
    assets = output / 'release-assets'
    records = list(inventory['files'])
    for record in binaries['artifacts']:
        name = record['name']
        if Path(name).name != name or name not in ('BilibiliSubtitle-0.1.0-Setup.exe', 'BilibiliSubtitle-0.1.0-win-x64.zip'):
            raise RuntimeError('unexpected_local_binary')
        source = seed / name
        if source.stat().st_size != record['bytes'] or sha(source) != record['sha256']:
            raise RuntimeError('locally_tested_binary_hash_mismatch')
        shutil.copyfile(source, assets / name)
        records.append(record)
    names = set()
    for record in records:
        name = record['name']
        if name in names or Path(name).name != name:
            raise RuntimeError('duplicate_or_unsafe_asset_name')
        names.add(name)
        path = assets / name
        if path.stat().st_size != record['bytes'] or sha(path) != record['sha256']:
            raise RuntimeError('release_asset_hash_mismatch')
    sums = assets / 'SHA256SUMS.txt'
    sums.write_text(''.join(f"{record['sha256']}  {record['name']}\n" for record in records), encoding='utf-8')
    records.append({'name': sums.name, 'bytes': sums.stat().st_size, 'sha256': sha(sums)})
    result = {'schemaVersion': 1, 'version': '0.1.0', 'tag': 'v0.1.0',
              'repository': 'humerus-sketch/streamer-bilingual-subtitles',
              'locallyTestedBinariesByteIdentical': True, 'allComponentFilesFrozenHashVerified': True,
              'files': records}
    (output / 'publish-inventory.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'event': 'publish_inventory_verified', 'assets': len(records)}), flush=True)


if __name__ == '__main__':
    main()
