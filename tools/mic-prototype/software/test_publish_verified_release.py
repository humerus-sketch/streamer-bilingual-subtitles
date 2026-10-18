import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish_verified_release.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
REPOSITORY = 'humerus-sketch/streamer-bilingual-subtitles'


class FakeGitHub:
    def __init__(self, draft=True, exists=True, by_id_draft=None):
        self.draft = draft
        self.exists = exists
        self.by_id_draft = by_id_draft
        self.assets = []
        self.calls = []
        self.asset = {'name': 'asset.zip', 'state': 'uploaded', 'size': 3,
                      'digest': 'sha256:' + hashlib.sha256(b'abc').hexdigest()}

    def __call__(self, *args, capture=True):
        self.calls.append(args)
        if args[0] == 'api':
            endpoint = args[-1]
            if endpoint.endswith('releases?per_page=100'):
                if '--paginate' not in args or '--slurp' not in args:
                    raise AssertionError('draft lookup must include pagination')
                # Exact target is on page two; the first page contains another tag.
                return json.dumps([[{'id': 1, 'tag_name': 'v0.1.0-old', 'draft': True}],
                                   [{'id': 42, 'tag_name': 'v0.1.0', 'draft': self.draft}] if self.exists else []])
            if endpoint.endswith('/releases/42'):
                return json.dumps({'id': 42, 'tag_name': 'v0.1.0',
                                   'draft': self.draft if self.by_id_draft is None else self.by_id_draft,
                                   'assets': self.assets})
            raise AssertionError('draft GET by tag is forbidden: ' + endpoint)
        if args[:2] == ('release', 'create'):
            self.exists = True
            return None
        if args[:2] == ('release', 'upload'):
            self.assets.append(self.asset)
            return None
        if args[:2] == ('release', 'edit'):
            self.draft = False
            return None
        raise AssertionError(args)


class PublishDraftContracts(unittest.TestCase):
    def run_publisher(self, fake, *, publish=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'release-assets').mkdir()
            (root / 'release-assets/asset.zip').write_bytes(b'abc')
            (root / 'notes.md').write_text('test notes', encoding='utf-8')
            inventory = {'repository': REPOSITORY, 'tag': 'v0.1.0',
                         'locallyTestedBinariesByteIdentical': True, 'allComponentFilesFrozenHashVerified': True,
                         'files': [{'name': 'asset.zip', 'bytes': 3, 'sha256': hashlib.sha256(b'abc').hexdigest()}]}
            (root / 'publish-inventory.json').write_text(json.dumps(inventory), encoding='utf-8')
            environment = {'GH_REPO': REPOSITORY, 'RELEASE_TARGET': 'a' * 40, 'PUBLISH_RELEASE': str(publish).lower()}
            with patch.object(publisher, 'gh', fake), patch.dict(publisher.os.environ, environment), \
                    patch.object(publisher.time, 'sleep', lambda _: None), \
                    patch('sys.argv', ['publisher', '--output', str(root), '--notes', str(root / 'notes.md')]):
                publisher.main()
            return json.loads((root / 'publish-result.json').read_text(encoding='utf-8'))

    def test_draft_visible_only_in_paginated_list_uploads_and_verifies_by_id(self):
        fake = FakeGitHub()
        report = self.run_publisher(fake)
        self.assertEqual(report['releaseId'], 42)
        self.assertEqual(report['assetsVerified'], 1)
        self.assertFalse(report['published'])
        self.assertEqual(sum(call[:2] == ('release', 'upload') for call in fake.calls), 1)
        self.assertFalse(any(call[:2] == ('release', 'create') for call in fake.calls))

    def test_new_draft_is_found_by_list_and_publication_confirmed_by_id(self):
        fake = FakeGitHub(exists=False)
        report = self.run_publisher(fake, publish=True)
        self.assertTrue(report['published'])
        self.assertEqual(sum(call[:2] == ('release', 'create') for call in fake.calls), 1)
        self.assertEqual(sum(call[:2] == ('release', 'edit') for call in fake.calls), 1)

    def test_published_release_is_preserved_without_upload_or_edit(self):
        fake = FakeGitHub(draft=False)
        with self.assertRaisesRegex(RuntimeError, 'published_release_is_immutable'):
            self.run_publisher(fake, publish=True)
        self.assertTrue(all(call[0] == 'api' for call in fake.calls))

    def test_publication_between_list_and_by_id_check_is_preserved(self):
        fake = FakeGitHub(draft=True, by_id_draft=False)
        with self.assertRaisesRegex(RuntimeError, 'published_release_is_immutable'):
            self.run_publisher(fake)
        self.assertTrue(all(call[0] == 'api' for call in fake.calls))

    def test_conflicting_draft_asset_is_not_overwritten(self):
        fake = FakeGitHub()
        fake.assets.append({**fake.asset, 'digest': 'sha256:' + '0' * 64})
        with self.assertRaisesRegex(RuntimeError, 'existing_draft_asset_conflict_preserved'):
            self.run_publisher(fake)
        self.assertTrue(all(call[0] == 'api' for call in fake.calls))


if __name__ == '__main__':
    unittest.main()
