# HIDRA Koper sea-level visualization

English (`en/`) and Slovenian (`sl/`) static plots of ARSO HIDRA forecasts and Koper sea-level measurements. The slider shows the latest 30 runs; the archive date selector opens any preserved historical run, with measurements loaded on demand. While viewing history the recent-run slider is hidden; **Return to latest forecast** restores it.

## Activate GitHub Pages and the durable archive

After reviewing and pushing this change to the default **master** branch:

1. Confirm your ARSO subscription permits **public redistribution and long-term retention** of derived forecasts and measurements. Retain ARSO attribution and the model references. An API key alone does not establish these rights.
2. Set repository Actions secret **`ARSO_HYDRA_API_KEY`** to an authorized Hydra subscription key.
3. Optionally set Actions variable **`ARSO_HYDRA_BASE_URL`** to `https://apis-g.arso.gov.si/hydra/` (the HTTPS default). Never put credentials in this variable or URL.
4. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**. Permit deployment from `master` in the `github-pages` environment. Repository/organization rules must allow the trusted build job's `GITHUB_TOKEN` to create/update **`hydra-data`**; no separate storage account, PAT, or external service is needed.
5. Run **Update Hydra and deploy Pages** manually on `master`. The first successful run creates the data-only branch automatically, backfills every run available in ARSO's paginated listing, validates the complete site, persists the archive, then uploads and deploys Pages. Allow up to 60 minutes for backfill. A missing branch is bootstrapped only after a successful Git query explicitly reports no matching ref; authentication/network failures never trigger a reset.

Pushes to `master`, manual runs on `master`, and an hourly schedule at **minute 17 UTC** update the site. Production updates are serialized. Pull requests run offline tests only, with no API secret or write/deploy privileges. GitHub schedules can be delayed/dropped and public-repository schedules may be disabled after 60 days of inactivity; re-enable and run manually when needed. Forks require their own authorized key and Pages configuration.

## Archive architecture and growth

**Application code stays on `master`; downloaded canonical data lives only on `hydra-data` and Pages.** This is not an Actions cache or an expiring artifact. Each data-branch commit stores compact monthly snapshots; unchanged files remain unchanged in Git. Normal pushes are fast-forward only, with no force push. A remote read-back verifies the pushed commit before Pages publication. Concurrent/unexpected remote changes fail closed; rerun rather than overwrite history.

The data branch contains only:

- `README.md`: source, representation, growth and redistribution notes.
- `index.json`: schema `Version: 1`, sorted archive-ID `Dates`, and `GaugeMonths`.
- `runs/YYYY/MM.json`: a map from source file IDs to `ForecastDate`, 72 hourly `Dates`, `Mean`, and `Std`.
- `gauges/YYYY/MM.json`: merged measurement `Dates` and `Values`.

This is a **visualization archive, not a raw-ensemble download archive**. The ensemble mean and mixture standard deviation are computed once from all available members, rounded to six decimals in cm. Mixture variance is `mean(member_std² + (member_mean - ensemble_mean)²)`, algebraically equivalent to the original frontend formula but avoiding cancellation. We do not retain the 50 raw member arrays or other upstream metadata.

Initial backfill downloads every listed run. Later builds fetch only missing IDs plus the latest **two** upstream IDs (which can be mutable), and the current gauge snapshot. Previously archived runs absent from the upstream listing are **retained**, never deleted. Historical observations embedded in each forecast's `Koper: {Dates, values}` are merged by timestamp; existing archived observations take precedence over retrospective input windows, and the current gauge snapshot takes precedence over both. Measurements absent from newer snapshots are retained. This recovers observations actually available in the source; it cannot invent missing observations or recover runs ARSO removed before the initial backfill. Older corrections outside the latest two runs are not automatically refetched.

The source file ID is **not necessarily the payload forecast issue time**. The selector labels the archive/source-file date and the selected view reports both the ID and actual issue time. The existing fixed **CET (UTC+1)** display convention is preserved; the source's actual timezone has not been independently established. Historical forecast windows can load measurement months across month/year boundaries. Gaps longer than two hours are broken in the plotted measurement line, not interpolated.

Data and Git history grow over time. Builds stop before publication at **20 MiB per monthly/index JSON file**, **100,000 runs**, or **800 MiB total Pages site**, leaving headroom below the Pages 1 GB site limit. These are safety stops, not pruning policies; old data is never silently evicted. Monitor data-branch Git history separately (the site cap does not bound Git history). Before approaching limits, migrate storage deliberately rather than delete history. Deleting `hydra-data` loses the durable archive and subsequent backfill can only recover runs still upstream; back up the branch if operationally important.

## Download and publication contract

The standard-library builder sends **GET only** to ARSO with `X-Gravitee-Api-Key` on each request. It reads ListObjectsV2 XML from `/?list-type=2&prefix=Hidra_`, follows continuation tokens, validates and deduplicates `Hidra_YYYYMMDDHH.json` IDs, and fails on malformed/cyclic/incomplete listings. Fewer than 30 listed runs is considered incomplete.

Forecasts require a parseable `ForecastDate`, exactly 72 consecutive hourly `Dates`, and nonempty ensemble members with finite numeric `values` and finite nonnegative `std`. Gauge snapshots and any present embedded Koper data require nonempty, strictly increasing timestamps and matching finite values. Existing compact archive files are revalidated, and corrupt/missing data never silently becomes a fresh archive.

Requests are serialized with at least 0.7 seconds between starts, including retries (below 100 requests/minute per key). HTTP 429 and transient server/transport failures allow four attempts maximum. `Retry-After` is respected; delays above 120 seconds abort rather than retry early. All redirects are rejected to prevent credential forwarding. Production requires HTTPS; explicit loopback HTTP is available only as a Python test constructor option. Use a dedicated key to avoid shared quota exhaustion.

A temporary sibling directory receives only public HTML, CSS, JavaScript and images; repository internals, scripts, token files and checked-in legacy `shared/data` are not copied. Validated Pages data is:

- `shared/data/dates.json`: latest 30 IDs and `GeneratedAt`, `LatestForecastAt`, `LatestGaugeAt` freshness metadata.
- `shared/data/runs/Hidra_YYYYMMDDHH.json`: latest 30 compact forecasts.
- `shared/data/mareografKP_vodostaj.json`: retained measurements covering the recent forecast windows.
- `shared/data/archive/`: the complete canonical archive above; historical months are fetched only when selected.

Only after the full backfill/update, schema validation, capacity checks and credential scan succeed are the fresh site and dedicated archive staging outputs exposed. Existing outputs are never overwritten. Any partial download failure publishes neither output. Actions then smoke-tests recent and historical views, persists the archive using an environment-only Git authentication header (no credential in URL, argv or stored Git config), verifies its remote commit, and uploads/deploys Pages. If Pages deployment fails after a successful archive push, data remains safely retained for the next run. No API key is embedded in browser assets, archive files or logs.

Browsers fetch same-origin files, not ARSO, so they need neither credentials nor gateway CORS. Localized errors cover failed data/plot loading. Staleness warnings appear when the bundle or current gauge is older than three hours or the latest forecast issue time exceeds 36 hours; missing metadata is stale too. This warning describes the **live feed's freshness**, not the age of a deliberately selected historical run. It is reevaluated every minute. This page is not an official warning service or a sole source for safety decisions.

## Local verification

Python 3.8+ and Node.js 18+; no pip/npm dependencies:

```sh
python -m unittest discover -s tests -v
node tests/frontend-smoke.cjs
node tests/archive-smoke.cjs
```

Tests cover paginated backfill, latest-30 output, compact statistics, incremental latest-two refresh, upstream disappearance retention, historical/current gauge merging, atomic failure, size caps, credential-safe GET transport, corrupt archives, and mocked Git bootstrap/nonforce/idempotent publication. The JavaScript tests execute the actual app in both languages using a small DOM/Plotly harness, not a full browser.

For an authorized initial local build, provide `ARSO_HYDRA_API_KEY` via your shell environment or secret manager (never a command-line argument), then:

```sh
python scripts/build_site.py --output _site-first --archive-output _archive-first
node tests/artifact-smoke.cjs _site-first
python -m http.server --directory _site-first 8000
```

For an incremental build, use the prior canonical output or a `hydra-data` checkout:

```sh
python scripts/build_site.py --archive-input _archive-first --archive-output _archive-next --output _site-next
node tests/artifact-smoke.cjs _site-next
```

Choose fresh output directories each time. Keep the previous archive until the next one has been validated; local builds do not commit or publish it. The optional private `arso.token` file is ignored and never read automatically. Do not serve the repository root. The Actions-only `archive_branch.py` is not needed for local builds. Artifact smoke tests select the oldest, middle and newest archive IDs in both languages and return to the latest plot.

Live API entitlement, upstream availability, browser rendering and permission to redistribute require separate verification; offline synthetic fixtures cannot prove them.
