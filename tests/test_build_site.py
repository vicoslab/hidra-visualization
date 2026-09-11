"""Offline contract/security tests; all HTTP is explicitly loopback-only."""
import copy
from datetime import datetime, timedelta
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('build_site', ROOT / 'scripts/build_site.py')
build = importlib.util.module_from_spec(SPEC) if SPEC else None
if SPEC and SPEC.loader and Path(SPEC.origin).exists():
    SPEC.loader.exec_module(build)


def forecast(identifier):
    start = datetime.strptime(identifier, '%Y%m%d%H')
    return {'ForecastDate': start.strftime('%d.%m.%Y %H:%M'),
            'Dates': [(start + timedelta(hours=i)).strftime('%d.%m.%Y %H:%M') for i in range(72)],
            'Hidra': [{'values': [200.0] * 72, 'std': [1.0] * 72}]}


class Clock:
    def __init__(self):
        self.now = 0
        self.waits = []
    def time(self):
        return self.now
    def sleep(self, seconds):
        self.waits.append(seconds)
        self.now += seconds


class BuilderTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(hasattr(build, 'build_site'), 'download/build implementation is missing')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name) / 'site'
        self.clock = Clock()
        self.requests = []
        self.mode = 'ok'
        self.failures = 0
        self.ids = [(datetime(2026, 9, 1) + timedelta(hours=i)).strftime('%Y%m%d%H') for i in range(35)]
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                outer.requests.append((self.path, self.headers.get('X-Gravitee-Api-Key')))
                parts = urlsplit(self.path)
                query = parse_qs(parts.query)
                status, headers = 200, {}
                if outer.mode == 'redirect':
                    status, headers, body = 302, {'Location': outer.base + 'leak'}, b'redirect'
                elif outer.mode == 'unauthorized':
                    status, body = 401, b'TEST_PRIVATE_KEY'
                elif outer.mode == 'rate' and outer.failures < 2:
                    outer.failures += 1
                    status, headers, body = 429, {'Retry-After': '3'}, b'limited'
                elif outer.mode == 'forever-rate':
                    status, headers, body = 429, {'Retry-After': '3'}, b'limited'
                elif parts.path == '/hydra/':
                    assert query['list-type'] == ['2'] and query['prefix'] == ['Hidra_']
                    second = 'continuation-token' in query
                    keys = outer.ids[:20] if not second else outer.ids[20:] + outer.ids[:2]
                    truncated = not second or outer.mode == 'cycle'
                    body = ('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
                            ''.join('<Contents><Key>Hidra_' + i + '.json</Key></Contents>' for i in reversed(keys)) +
                            '<Contents><Key>../secret</Key></Contents>' +
                            '<IsTruncated>' + str(truncated).lower() + '</IsTruncated>' +
                            ('<NextContinuationToken>a+/=&amp;</NextContinuationToken>' if truncated else '') +
                            '</ListBucketResult>').encode()
                    if second:
                        assert query['continuation-token'] == ['a+/=&']
                elif parts.path.endswith('/mareografKP_vodostaj.json'):
                    body = json.dumps({'Dates': ['01.09.2026 00:00', '01.09.2026 00:10'], 'Values': [200, 201]}).encode()
                else:
                    data = forecast(Path(parts.path).stem[len('Hidra_'):])
                    if outer.mode == 'invalid':
                        data['Hidra'][0]['std'][0] = -1
                    body = json.dumps(data).encode()
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.base = f'http://127.0.0.1:{self.server.server_port}/hydra/'
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def client(self):
        return build.Client(self.base, 'TEST_PRIVATE_KEY', allow_local_http=True,
                            clock=self.clock.time, sleep=self.clock.sleep)

    def test_complete_paginated_bundle_and_asset_isolation(self):
        build.build_site(ROOT, self.output, self.client())
        manifest = json.loads((self.output / 'shared/data/dates.json').read_text())
        self.assertEqual(manifest['Dates'], self.ids[-30:])
        self.assertTrue(manifest['GeneratedAt'].endswith('+00:00'))
        self.assertEqual(len(list((self.output / 'shared/data/runs').glob('*.json'))), 30)
        self.assertEqual(len(self.requests), 33)
        self.assertTrue(all(key == 'TEST_PRIVATE_KEY' for _, key in self.requests))
        self.assertTrue(all(self.output.joinpath(p).is_file() for p in ['en/index.html', 'sl/index.html', 'index.html', 'shared/js/app.js', 'shared/data/mareografKP_vodostaj.json']))
        self.assertFalse((self.output / '.git').exists())
        self.assertFalse((self.output / 'scripts').exists())
        for path in self.output.rglob('*'):
            if path.is_file():
                self.assertNotIn(b'TEST_PRIVATE_KEY', path.read_bytes())
        self.assertGreaterEqual(self.clock.now + 1e-9, 32 * 0.7)

    def test_incomplete_bundle_never_published(self):
        self.mode = 'invalid'
        with self.assertRaises(build.BuildError):
            build.build_site(ROOT, self.output, self.client())
        self.assertFalse(self.output.exists())
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_existing_output_is_never_overwritten(self):
        self.output.mkdir()
        (self.output / 'sentinel').write_text('previous')
        with self.assertRaises(build.BuildError):
            build.build_site(ROOT, self.output, self.client())
        self.assertEqual((self.output / 'sentinel').read_text(), 'previous')
        self.assertEqual(self.requests, [])

    def test_no_redirect_follow_or_secret_diagnostics(self):
        self.mode = 'redirect'
        with self.assertRaises(build.BuildError) as caught:
            self.client().get('')
        self.assertEqual(len(self.requests), 1)
        self.assertNotIn('TEST_PRIVATE_KEY', str(caught.exception))
        self.mode = 'unauthorized'
        with self.assertRaises(build.BuildError) as caught:
            self.client().get('')
        self.assertEqual(len(self.requests), 2)
        self.assertNotIn('TEST_PRIVATE_KEY', str(caught.exception))

    def test_retry_after_and_bounded_retries(self):
        self.mode = 'rate'
        self.client().get('', {'list-type': '2', 'prefix': 'Hidra_'})
        self.assertEqual(len(self.requests), 3)
        self.assertGreaterEqual(self.clock.now, 6)
        self.mode = 'forever-rate'
        self.requests.clear()
        with self.assertRaises(build.BuildError):
            self.client().get('')
        self.assertEqual(len(self.requests), 4)

    def test_pagination_cycle_fails_closed(self):
        self.mode = 'cycle'
        with self.assertRaises(build.BuildError):
            build.build_site(ROOT, self.output, self.client())
        self.assertFalse(self.output.exists())
        self.assertEqual(len(self.requests), 2)

    def test_url_and_header_security(self):
        for url in [self.base, 'http://example.com/', 'https://user:password@example.com/', 'https://example.com/?key=x', 'https://example.com/#x']:
            with self.subTest(url=url), self.assertRaises(build.BuildError):
                build.Client(url, 'secret')
        for path in ['https://evil.example/', '//evil.example/', '../escape', 'a?secret=x']:
            with self.subTest(path=path), self.assertRaises(build.BuildError):
                self.client().get(path)
        for key in ['', 'abc\r\nX: y']:
            with self.assertRaises(build.BuildError):
                build.Client('https://example.com/hydra/', key)
        self.assertEqual(self.requests, [])

    def test_forecast_schema(self):
        identifier = self.ids[-1]
        valid = forecast(identifier)
        build.validate_forecast(valid, identifier)
        mutations = [lambda d: d['Dates'].pop(),
                     lambda d: d['Dates'].__setitem__(1, d['Dates'][0]),
                     lambda d: d['Hidra'][0]['values'].__setitem__(0, float('nan')),
                     lambda d: d['Hidra'][0]['values'].__setitem__(0, True),
                     lambda d: d['Hidra'][0]['std'].__setitem__(0, -1),
                     lambda d: d.__setitem__('ForecastDate', 'bad'),
                     lambda d: d.__setitem__('Hidra', [])]
        for mutate in mutations:
            data = copy.deepcopy(valid)
            mutate(data)
            with self.assertRaises(build.BuildError):
                build.validate_forecast(data, identifier)

    def test_gauge_schema(self):
        for data in [{'Dates': [], 'Values': []}, {'Dates': ['bad'], 'Values': [1]},
                     {'Dates': ['01.09.2026 00:00'], 'Values': [float('inf')]},
                     {'Dates': ['01.09.2026 00:00'], 'Values': []}]:
            with self.assertRaises(build.BuildError):
                build.validate_gauge(data)

    def test_filename_is_archive_id_not_payload_issue_time(self):
        data = forecast('2026091106')
        data['ForecastDate'] = '11.09.2026 05:50'
        self.assertEqual(build.validate_forecast(data, '2026091000')['ForecastDate'], '11.09.2026 05:50')


if __name__ == '__main__':
    unittest.main()
