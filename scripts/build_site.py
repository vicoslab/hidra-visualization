#!/usr/bin/env python3
"""Build a complete, credential-free Pages artifact using only stdlib.

No redirect is ever followed. HTTP is available only through an explicit Python
constructor argument for loopback tests; the CLI always requires HTTPS.
"""
import argparse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import json
import math
import os
from pathlib import Path
import re
import shutil
import socket
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import xml.etree.ElementTree as ET

DEFAULT_BASE = 'https://apis-g.arso.gov.si/hydra/'
RUN_KEY = re.compile(r'Hidra_([0-9]{10})\.json\Z')
CET = timezone(timedelta(hours=1))  # Upstream/display contract: fixed CET, not local DST.
MAX_BYTES = 20 * 1024 * 1024
MAX_SITE_BYTES = 800 * 1024 * 1024  # Headroom below Pages' 1 GB published-site limit.
MAX_MONTH_BYTES = 20 * 1024 * 1024
MAX_RUNS = 100000


class BuildError(Exception):
    """Safe, static diagnostics only: never upstream bodies, URLs, or headers."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base, key, *, allow_local_http=False, clock=time.monotonic, sleep=time.sleep):
        try:
            parts = urlsplit(base)
            local = allow_local_http and parts.scheme == 'http' and parts.hostname in ('127.0.0.1', '::1', 'localhost')
            if (not parts.hostname or (parts.scheme != 'https' and not local) or parts.username is not None
                    or parts.password is not None or parts.query or parts.fragment
                    or any(ord(c) < 33 or ord(c) > 126 for c in base) or '\\' in base):
                raise ValueError
            _ = parts.port
        except (ValueError, TypeError):
            raise BuildError('Invalid API base: use an HTTPS URL without credentials, query, or fragment.') from None
        if not isinstance(key, str) or not key or any(ord(c) < 33 or ord(c) > 126 for c in key):
            raise BuildError('ARSO_HYDRA_API_KEY is missing or invalid.')
        self.base, self.key = base.rstrip('/') + '/', key
        self.clock, self.sleep = clock, sleep
        self.last_request = None
        # Ignore ambient proxy settings: the API key must go only to the configured origin.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def get(self, name, query=None):
        if name and not (RUN_KEY.fullmatch(name) or name == 'mareografKP_vodostaj.json'):
            raise BuildError('Invalid API object name.')
        url = self.base + name + ('?' + urlencode(query) if query else '')
        for attempt in range(4):
            if self.last_request is not None:
                self.sleep(max(0, 0.7 - (self.clock() - self.last_request)))
            self.last_request = self.clock()
            request = Request(url, headers={'X-Gravitee-Api-Key': self.key, 'Accept': 'application/json, application/xml'}, method='GET')
            try:
                with self.opener.open(request, timeout=30) as response:
                    if response.status != 200:
                        raise BuildError('API returned an unexpected status.')
                    body = response.read(MAX_BYTES + 1)
                    if len(body) > MAX_BYTES:
                        raise BuildError('API response exceeds the size limit.')
                    return body
            except HTTPError as exc:
                status = exc.code
                retry_after = exc.headers.get('Retry-After')
                exc.close()
                if status not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise BuildError(f'API request failed (HTTP {status}); no artifact published.') from None
                delay = 2 ** attempt
                if retry_after:
                    try:
                        delay = max(delay, float(retry_after))
                    except ValueError:
                        try:
                            delay = max(delay, (parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds())
                        except (ValueError, TypeError, OverflowError):
                            raise BuildError('Invalid Retry-After; stopping safely.') from None
                    # Do not shorten server-requested delays: abort instead of retrying early.
                    if not math.isfinite(delay) or delay > 120:
                        raise BuildError('Retry-After exceeds the bounded retry budget; stopping safely.')
                self.sleep(delay)
            except (URLError, TimeoutError, socket.timeout, OSError):
                if attempt == 3:
                    raise BuildError('API transport failed; no artifact published.') from None
                self.sleep(2 ** attempt)
        raise BuildError('Retry budget exhausted.')


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{2}\.[0-9]{2}\.[0-9]{4} [0-9]{2}:[0-9]{2}', value):
        raise BuildError('Invalid data timestamp.')
    try:
        return datetime.strptime(value, '%d.%m.%Y %H:%M').replace(tzinfo=CET)
    except ValueError:
        raise BuildError('Invalid data timestamp.') from None


def numeric_array(values, length, *, nonnegative=False):
    if not isinstance(values, list) or len(values) != length:
        raise BuildError('Invalid numeric array length.')
    for v in values:
        if type(v) not in (int, float) or not math.isfinite(v) or (nonnegative and v < 0):
            raise BuildError('Invalid numeric data.')


def validate_forecast(data, identifier):
    try:
        # The archive ID is not the issue time (confirmed on the gateway).
        timestamp(data['ForecastDate'])
        dates = data['Dates']
        if not isinstance(dates, list) or len(dates) != 72:
            raise BuildError('Forecast must contain 72 hourly dates.')
        times = [timestamp(d) for d in dates]
        if any(b - a != timedelta(hours=1) for a, b in zip(times, times[1:])):
            raise BuildError('Forecast dates must be hourly and ordered.')
        members = data['Hidra']
        if not isinstance(members, list) or not members:
            raise BuildError('Forecast ensemble is empty.')
        for member in members:
            numeric_array(member['values'], 72)
            numeric_array(member['std'], 72, nonnegative=True)
        # Publish a schema allowlist, never arbitrary upstream metadata/echoed secrets.
        return {'ForecastDate': data['ForecastDate'], 'Dates': dates,
                'Hidra': [{'values': m['values'], 'std': m['std']} for m in members]}
    except (KeyError, TypeError, OverflowError):
        raise BuildError('Invalid forecast schema.') from None


def validate_gauge(data):
    try:
        dates = data['Dates']
        if not isinstance(dates, list) or not dates:
            raise BuildError('Gauge data is empty.')
        times = [timestamp(d) for d in dates]
        if any(b <= a for a, b in zip(times, times[1:])):
            raise BuildError('Gauge dates must be increasing.')
        numeric_array(data['Values'], len(dates))
        return {'Dates': dates, 'Values': data['Values']}
    except (KeyError, TypeError, OverflowError):
        raise BuildError('Invalid gauge schema.') from None


def decode_json(body):
    try:
        return json.loads(body)
    except (ValueError, UnicodeError):
        raise BuildError('API returned invalid JSON.') from None


def list_runs(client):
    identifiers, seen_tokens = set(), set()
    query = {'list-type': '2', 'prefix': 'Hidra_'}
    for _ in range(1000):
        body = client.get('', query)
        if b'<!DOCTYPE' in body.upper() or b'<!ENTITY' in body.upper():
            raise BuildError('Unsupported XML declarations.')
        try:
            root = ET.fromstring(body)
        except ET.ParseError:
            raise BuildError('API returned invalid listing XML.') from None
        # Handle both standard S3 namespace and unnamespaced S3-compatible XML.
        if root.tag.split('}')[-1] != 'ListBucketResult':
            raise BuildError('Unexpected listing XML root.')
        for item in root.findall('{*}Contents/{*}Key'):
            match = RUN_KEY.fullmatch(item.text or '')
            if match:
                identifier = match[1]
                try:
                    datetime.strptime(identifier, '%Y%m%d%H')
                except ValueError:
                    raise BuildError('Invalid forecast object timestamp.') from None
                identifiers.add(identifier)
        truncated = root.findtext('{*}IsTruncated')
        if truncated == 'false':
            if len(identifiers) < 30:
                raise BuildError('Listing contains fewer than 30 runs; refusing incomplete history.')
            if len(identifiers) > MAX_RUNS:
                raise BuildError('Archive exceeds the run limit.')
            return sorted(identifiers)
        token = root.findtext('{*}NextContinuationToken')
        if truncated != 'true' or not token or token in seen_tokens:
            raise BuildError('Incomplete or cyclic archive listing.')
        seen_tokens.add(token)
        query['continuation-token'] = token
    raise BuildError('Archive listing exceeds the page limit.')


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, allow_nan=False, separators=(',', ':')) + '\n', encoding='utf-8')


def copy_assets(source, stage):
    # Only designated public assets: never copy the repository wholesale or old data.
    paths = [source / 'index.html', source / 'en/index.html', source / 'sl/index.html']
    allowed = {'.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2'}
    for directory in ('shared/css', 'shared/js', 'shared/img'):
        folder = source / directory
        if folder.is_symlink():
            raise BuildError('Symlinked assets are not allowed.')
        paths.extend(p for p in folder.rglob('*') if p.is_file() and p.suffix.lower() in allowed and not any(part.startswith('.') for part in p.relative_to(source).parts))
    for path in paths:
        if path.is_symlink() or any(p.is_symlink() for p in path.parents if p != source and source in p.parents):
            raise BuildError('Symlinked assets are not allowed.')
        target = stage / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)


def compact_forecast(raw, identifier):
    data = validate_forecast(raw, identifier)
    means, stds = [], []
    for i in range(72):
        members = data['Hidra']
        mean = math.fsum(m['values'][i] / len(members) for m in members)
        # Equivalent mixture variance, without cancellation of large squared means.
        variance = math.fsum((m['std'][i] ** 2 + (m['values'][i] - mean) ** 2) / len(members) for m in members)
        means.append(round(mean, 6))
        stds.append(round(math.sqrt(variance), 6))
    return {'ForecastDate': data['ForecastDate'], 'Dates': data['Dates'], 'Mean': means, 'Std': stds}


def validate_compact(data, identifier):
    try:
        clean = validate_forecast({'ForecastDate': data['ForecastDate'], 'Dates': data['Dates'],
                                  'Hidra': [{'values': data['Mean'], 'std': data['Std']}]}, identifier)
        return {'ForecastDate': clean['ForecastDate'], 'Dates': clean['Dates'],
                'Mean': clean['Hidra'][0]['values'], 'Std': clean['Hidra'][0]['std']}
    except (KeyError, TypeError):
        raise BuildError('Invalid compact archive schema.') from None


def month_path(month):
    if not isinstance(month, str) or not re.fullmatch(r'[0-9]{4}(0[1-9]|1[0-2])', month):
        raise BuildError('Invalid archive month.')
    return month[:4] + '/' + month[4:] + '.json'


def load_archive(folder):
    runs, gauges = {}, {}
    if folder is None:
        return runs, gauges
    folder = Path(folder)
    def read(relative):
        path = folder / relative
        if path.is_symlink() or any(p.is_symlink() for p in path.parents) or not path.is_file() or path.stat().st_size > MAX_MONTH_BYTES:
            raise BuildError('Missing, unsafe or oversized archive file.')
        return decode_json(path.read_bytes())
    try:
        index = read('index.json')
        ids = index['Dates']
        if index['Version'] != 1 or not isinstance(ids, list) or not ids or len(ids) > MAX_RUNS or ids != sorted(set(ids)):
            raise BuildError('Invalid archive index.')
        for identifier in ids:
            if not isinstance(identifier, str) or not RUN_KEY.fullmatch('Hidra_' + identifier + '.json'):
                raise BuildError('Invalid archive identifier.')
            datetime.strptime(identifier, '%Y%m%d%H')
        for month in sorted({i[:6] for i in ids}):
            data = read('runs/' + month_path(month))
            expected = {i for i in ids if i.startswith(month)}
            if set(data) != expected:
                raise BuildError('Archive index and monthly runs disagree.')
            runs.update({i: validate_compact(data[i], i) for i in expected})
        months = index['GaugeMonths']
        if not isinstance(months, list) or months != sorted(set(months)):
            raise BuildError('Invalid gauge month index.')
        for month in months:
            data = validate_gauge(read('gauges/' + month_path(month)))
            if any(timestamp(d).strftime('%Y%m') != month for d in data['Dates']):
                raise BuildError('Gauge observation in wrong month.')
            gauges.update(zip(data['Dates'], data['Values']))
        return runs, gauges
    except (KeyError, TypeError, ValueError, OSError):
        raise BuildError('Invalid or incomplete existing archive; refusing to reset it.') from None


def write_archive(folder, runs, gauges):
    ids = sorted(runs)
    if len(ids) > MAX_RUNS:
        raise BuildError('Archive exceeds the run limit.')
    months = {}
    for identifier in ids:
        months.setdefault(identifier[:6], {})[identifier] = runs[identifier]
    for month, data in months.items():
        write_json(folder / 'runs' / month_path(month), data)
    gauge_months = {}
    for date in sorted(gauges, key=timestamp):
        data = gauge_months.setdefault(timestamp(date).strftime('%Y%m'), {'Dates': [], 'Values': []})
        data['Dates'].append(date)
        data['Values'].append(gauges[date])
    for month, data in gauge_months.items():
        write_json(folder / 'gauges' / month_path(month), data)
    write_json(folder / 'index.json', {'Version': 1, 'Dates': ids, 'GaugeMonths': sorted(gauge_months)})
    (folder / 'README.md').write_text('# Public HIDRA visualization archive\n\n'
        'Generated canonical data only; application code lives on master. Do not edit by hand.\n'
        'runs/YYYY/MM.json stores forecast dates, hourly means and mixture standard deviations\n'
        '(rounded to 6 decimals), not the raw ensembles. gauges/YYYY/MM.json retains observations.\n'
        'Index IDs are source filenames, not necessarily payload issue times. Fixed CET display\n'
        'is retained; source timezone has not been independently established.\n\n'
        'Data grows with every new run and observation; old runs absent upstream are retained.\n'
        'Monthly snapshots and Git history are durable, not Actions caches or expiring artifacts.\n'
        'Builds fail before publication at 20 MiB per month or 800 MiB site size. Monitor Git\n'
        'history growth too; these caps do not bound Git history. Never force-push this branch.\n\n'
        'Source: ARSO, HIDRA. This branch and Pages publicly redistribute derived forecasts\n'
        'and measurements. The operator must verify ARSO permission and attribution terms\n'
        'before enabling publication. API access alone does not grant redistribution rights.\n', encoding='utf-8')
    if any(p.stat().st_size > MAX_MONTH_BYTES for p in folder.rglob('*.json')):
        raise BuildError('Archive month exceeds size limit; no publication.')


def build_site(source, output, client, *, archive_input=None, archive_output=None):
    source, output = Path(source).resolve(), Path(output).absolute()
    archive_output = Path(archive_output).absolute() if archive_output is not None else None
    for target in [output] + ([archive_output] if archive_output else []):
        if target.exists() or target.is_symlink():
            raise BuildError('Output already exists; choose a fresh dedicated output directory.')
    if archive_output and (output == archive_output or output in archive_output.parents or archive_output in output.parents):
        raise BuildError('Site and archive outputs must be separate.')
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.hydra-stage-', dir=output.parent))
    archive_stage = None
    try:
        runs, persisted_gauges = load_archive(archive_input)
        ids = list_runs(client)
        embedded = {}
        for identifier in ids:
            if identifier in runs and identifier not in ids[-2:]:
                continue
            raw = decode_json(client.get(f'Hidra_{identifier}.json'))
            runs[identifier] = compact_forecast(raw, identifier)
            if 'Koper' in raw:
                try:
                    data = validate_gauge({'Dates': raw['Koper']['Dates'], 'Values': raw['Koper']['values']})
                except (KeyError, TypeError):
                    raise BuildError('Invalid embedded Koper measurements.') from None
                embedded.update(zip(data['Dates'], data['Values']))
        # Persisted observations outrank retrospective input windows; current gauge wins.
        embedded.update(persisted_gauges)
        gauge = validate_gauge(decode_json(client.get('mareografKP_vodostaj.json')))
        embedded.update(zip(gauge['Dates'], gauge['Values']))
        copy_assets(source, stage)
        archive = stage / 'shared/data/archive'
        write_archive(archive, runs, embedded)
        # Validate every canonical file before exposing either output.
        load_archive(archive)
        latest_ids = sorted(runs)[-30:]
        for identifier in latest_ids:
            write_json(stage / f'shared/data/runs/Hidra_{identifier}.json', runs[identifier])
        # Latest plot includes retained observations throughout all 30 forecast windows.
        start = min(timestamp(runs[i]['Dates'][0]) for i in latest_ids) - timedelta(hours=24)
        end = max(timestamp(runs[i]['Dates'][-1]) for i in latest_ids)
        dates = sorted((d for d in embedded if start <= timestamp(d) <= end), key=timestamp)
        write_json(stage / 'shared/data/mareografKP_vodostaj.json', {'Dates': dates, 'Values': [embedded[d] for d in dates]})
        write_json(stage / 'shared/data/dates.json', {
            'Dates': latest_ids, 'GeneratedAt': datetime.now(timezone.utc).isoformat(),
            'LatestForecastAt': timestamp(runs[latest_ids[-1]]['ForecastDate']).isoformat(),
            'LatestGaugeAt': timestamp(gauge['Dates'][-1]).isoformat(),
        })
        (stage / '.nojekyll').touch()
        secret = client.key.encode('ascii')
        total = 0
        for path in stage.rglob('*'):
            if path.is_file():
                total += path.stat().st_size
                if secret in path.read_bytes():
                    raise BuildError('Credential detected in artifact; refusing publication.')
        if total > MAX_SITE_BYTES:
            raise BuildError('Site exceeds 800 MiB safety cap; no publication.')
        if archive_output:
            archive_output.parent.mkdir(parents=True, exist_ok=True)
            archive_stage = Path(tempfile.mkdtemp(prefix='.hydra-archive-', dir=archive_output.parent))
            shutil.copytree(archive, archive_stage, dirs_exist_ok=True)
            archive_stage.rename(archive_output)
        try:
            stage.rename(output)
        except OSError:
            if archive_output:
                shutil.rmtree(archive_output)
            raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
        if archive_stage and archive_stage.exists():
            shutil.rmtree(archive_stage)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='_site')
    parser.add_argument('--archive-input', help='Existing hydra-data checkout (omit only for initial backfill)')
    parser.add_argument('--archive-output', default='_archive-next', help='Fresh canonical archive staging directory')
    args = parser.parse_args()
    try:
        client = Client(os.environ.get('ARSO_HYDRA_BASE_URL') or DEFAULT_BASE,
                        os.environ.get('ARSO_HYDRA_API_KEY', ''))
        build_site(Path(__file__).resolve().parents[1], Path(args.output), client,
                   archive_input=args.archive_input, archive_output=args.archive_output)
    except BuildError as exc:
        parser.exit(1, f'Build failed: {exc}\n')
    except Exception:
        # No traceback: transport/library exceptions can contain request details.
        parser.exit(1, 'Build failed unexpectedly; no artifact published.\n')
    print('Built validated Pages artifact and complete compact historical archive.')


if __name__ == '__main__':
    main()
