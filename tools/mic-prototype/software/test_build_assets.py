import hashlib
from pathlib import Path
import tempfile
import unittest
import zipfile

from build_assets import copy_tree, digest, package


class AssetContracts(unittest.TestCase):
    def test_zip_root_and_manifest_sizes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'root'
            release = Path(temporary) / 'release-assets'
            (root / 'nested').mkdir(parents=True)
            release.mkdir()
            (root / 'python.exe').write_bytes(b'fixture executable')
            (root / 'nested/module.py').write_text('pass\n', encoding='utf-8')
            result = package(root, release, 'component.zip')
            with zipfile.ZipFile(release / result['fileName']) as archive:
                self.assertEqual(set(archive.namelist()), {'python.exe', 'nested/module.py'})
                self.assertEqual(sum(item.file_size for item in archive.infolist()), result['expandedBytes'])
            self.assertEqual(result['sha256'], digest(release / 'component.zip'))
            self.assertEqual(result['archiveBytes'], result['bytes'])

    def test_parts_reassemble_one_standard_zip(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'root'
            release = Path(temporary) / 'release-assets'
            root.mkdir()
            release.mkdir()
            (root / 'model.bin').write_bytes(bytes(range(256)) * 20)
            result = package(root, release, 'model.zip', split_bytes=1024)
            joined = b''.join((release / part['name']).read_bytes() for part in result['parts'])
            self.assertGreater(len(result['parts']), 1)
            self.assertTrue(all(part['bytes'] <= 1024 for part in result['parts']))
            self.assertEqual(len(joined), result['archiveBytes'])
            self.assertEqual(hashlib.sha256(joined).hexdigest(), result['archiveSha256'])
            archive = Path(temporary) / 'joined.zip'
            archive.write_bytes(joined)
            with zipfile.ZipFile(archive) as source:
                self.assertEqual(source.read('model.bin'), (root / 'model.bin').read_bytes())

    def test_environment_hooks_are_not_collected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'source'
            target = Path(temporary) / 'target'
            root.mkdir()
            target.mkdir()
            for name in ('module.py', '_virtualenv.py', '_virtualenv.pth', 'sitecustomize.py',
                         'usercustomize.py', 'pyvenv.cfg', 'module.pyc', 'direct_url.json'):
                (root / name).write_text('fixture', encoding='utf-8')
            copy_tree(root, target)
            self.assertEqual({path.name for path in target.iterdir()}, {'module.py'})

    def test_cuda_developer_headers_excluded_runtime_dll_kept(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'source'
            target = Path(temporary) / 'target'
            (root / 'nvidia/cublas/include').mkdir(parents=True)
            (root / 'nvidia/cublas/bin').mkdir()
            (root / 'nvidia/cublas/include/cublas.h').write_text('developer header', encoding='utf-8')
            (root / 'nvidia/cublas/bin/cublas64_12.dll').write_bytes(b'runtime')
            copy_tree(root, target)
            self.assertFalse((target / 'nvidia/cublas/include').exists())
            self.assertEqual((target / 'nvidia/cublas/bin/cublas64_12.dll').read_bytes(), b'runtime')


if __name__ == '__main__':
    unittest.main()
