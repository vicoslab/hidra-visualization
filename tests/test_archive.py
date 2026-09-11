"""Offline durable archive contracts (no credentials or external network)."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_build_site import build, forecast, ROOT

class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.ids = ['2020010100'] + ['202609%02d00' % d for d in range(1, 31)]
        self.calls = []
        outer = self
        class Client:
            key = 'FAKE_ARCHIVE_SECRET'
            def get(self, name, query=None):
                outer.calls.append(name)
                if not name:
                    return ('<ListBucketResult><IsTruncated>false</IsTruncated>' + ''.join('<Contents><Key>Hidra_'+i+'.json</Key></Contents>' for i in outer.ids) + '</ListBucketResult>').encode()
                if name == 'mareografKP_vodostaj.json':
                    return json.dumps({'Dates':['01.09.2026 00:00'], 'Values':[222]}).encode()
                data = forecast(name[6:-5])
                data['Hidra'].append({'values':[202]*72, 'std':[1]*72})
                data['Koper'] = {'Dates':[data['Dates'][0]], 'values':[199]}
                return json.dumps(data).encode()
        self.client = Client()

    def run_build(self, name, previous=None):
        site, archive = self.root/name, self.root/(name+'-archive')
        build.build_site(ROOT, site, self.client, archive_input=previous, archive_output=archive)
        return site, archive

    def test_backfill_compact_incremental_retention_and_gauges(self):
        site, archive = self.run_build('first')
        manifest = json.loads((archive/'index.json').read_text())
        self.assertEqual(manifest['Dates'], self.ids)
        old = json.loads((archive/'runs/2020/01.json').read_text())['2020010100']
        self.assertNotIn('Hidra', old)
        self.assertEqual(old['Mean'], [201]*72)
        self.assertAlmostEqual(old['Std'][0], 2**0.5, places=5)
        self.assertEqual(json.loads((archive/'gauges/2020/01.json').read_text())['Values'], [199])
        self.assertEqual(json.loads((archive/'gauges/2026/09.json').read_text())['Values'][0],222)
        self.assertEqual(len(list((site/'shared/data/runs').glob('*.json'))),30)
        self.ids.remove('2020010100')
        self.calls.clear()
        _, second = self.run_build('second', archive)
        fetched = [n for n in self.calls if n.startswith('Hidra_')]
        self.assertEqual(fetched, ['Hidra_'+i+'.json' for i in self.ids[-2:]])
        self.assertIn('2020010100',json.loads((second/'index.json').read_text())['Dates'])
        self.assertEqual((second/'runs/2020/01.json').read_bytes(),(archive/'runs/2020/01.json').read_bytes())
        self.assertEqual((second/'gauges/2026/09.json').read_bytes(),(archive/'gauges/2026/09.json').read_bytes())

    def test_partial_failure_publishes_neither_output(self):
        original = self.client.get
        def fail(name, query=None):
            if name == 'Hidra_'+self.ids[-1]+'.json':
                raise build.BuildError('API request failed')
            return original(name,query)
        self.client.get = fail
        with self.assertRaises(build.BuildError): self.run_build('failed')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_size_cap_fails_closed(self):
        with patch.object(build,'MAX_SITE_BYTES',1), self.assertRaises(build.BuildError):
            self.run_build('large')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_corrupt_existing_archive_fails_not_silent_bootstrap(self):
        archive = self.root/'bad'
        archive.mkdir()
        (archive/'index.json').write_text('{}')
        with self.assertRaises(build.BuildError): self.run_build('badsite',archive)
        self.assertFalse((self.root/'badsite').exists())

if __name__ == '__main__': unittest.main()
