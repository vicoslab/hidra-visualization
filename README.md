# HIDRA Koper sea-level visualization

English (`en/`) and Slovenian (`sl/`) static plots of ARSO HIDRA ensemble forecasts and Koper sea-level measurements.

## Activate GitHub Pages

After reviewing and pushing this change to the default **master** branch:

1. Request a replacement ARSO S3/Hydra key (the emailed key was exposed in a message). In **Settings → Secrets and variables → Actions → Secrets**, update **`ARSO_HYDRA_API_KEY`** to that key. Keep it out of repository files, URLs and logs.
2. The workflow defaults to **`https://apis-g.arso.gov.si/s3/hydra/`**. If a custom URL is needed, set the optional Actions variable **`ARSO_HYDRA_S3_BASE_URL`** to this HTTPS base path. The old `ARSO_HYDRA_BASE_URL` variable is no longer used by Actions and can be removed; the local builder still accepts the `ARSO_HYDRA_BASE_URL` environment variable.
3. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**. Ensure the `github-pages` environment permits deployment from `master`.
4. Open **Actions → Update Hydra and deploy Pages → Run workflow**, select **master**, and run it. Check that test, build, upload and deployment succeed; use the deployment URL shown there.

Pushes to `master`, manual runs on `master`, and daily scheduling at **08:17 UTC** update the site. Pull requests run offline tests only, without the API secret or deployment privileges. GitHub schedules can be delayed or dropped and are not a real-time guarantee; scheduled workflows in public repositories can be disabled after 60 days of inactivity. Re-enable them in Actions and run manually if necessary. Forks must configure their own authorized key and Pages settings.

## Download and publication contract

The Python standard-library builder sends **GET only** (no writes to ARSO) to the new `/s3/hydra/` bucket, with `X-Gravitee-Api-Key` on every request rather than `api-key` in the URL. It reads S3 ListObjectsV2 XML from `?list-view=&list-type=2&prefix=Hidra_`, follows `NextContinuationToken` when `IsTruncated` is true, deduplicates all matching `Hidra_YYYYMMDDHH.json` object IDs, and selects the latest **30** in ascending order. Malformed, cyclic, excessively large, or incomplete listings fail closed. Fewer than 30 runs is considered incomplete.

Each forecast must have a parseable `ForecastDate`, exactly 72 consecutive hourly `Dates`, and nonempty `Hidra` members containing 72 finite numeric `values` and nonnegative finite `std` values. **The filename is an archive ID, not necessarily the payload issue time**; they are deliberately not required to match. The gauge `mareografKP_vodostaj.json` must contain nonempty, strictly increasing `Dates` and equally sized finite numeric `Values`. Dates use the existing fixed CET (UTC+1) data/display convention. Metadata timestamps include an explicit offset.

Normally the workflow reads the previous public Pages bundle from the repository-derived `https://OWNER.github.io/REPO/` root (no authentication or API key sent there). It verifies the existing 30-run manifest and each published forecast before reading the ARSO listing, then reuses immutable runs; it refreshes the newest run and gauge and downloads any newly listed runs. A first deployment with no landing page bootstraps all 30 forecasts. Missing/invalid cache objects or an inaccessible site abort rather than silently requesting another 30 forecasts. Custom Pages domains that redirect the repository-derived URL need an explicitly configured trusted origin before this workflow can build; redirects fail closed. Each build still requires a complete upstream listing, which may itself span multiple requests.

Requests are serialized with at least 0.7 seconds between starts (below **100 requests/minute per key**, including retries). HTTP 429 and transient server/transport failures allow at most four attempts per request. `Retry-After` seconds or HTTP dates are respected; a delay over 120 seconds aborts rather than retrying early. All redirects are rejected, including same-origin redirects, to prevent credential forwarding. HTTPS is mandatory in production; explicit loopback HTTP exists only as a Python test constructor option, never a CLI/environment bypass. Use a dedicated key: other applications sharing it can still exhaust its quota.

A temporary sibling directory receives only `index.html`, `en/index.html`, `sl/index.html`, and public assets in `shared/css`, `shared/js`, `shared/img`. Repository internals, scripts, token files and **historical checked-in `shared/data` are not copied**. Validated, schema-allowlisted data is published as:

- `shared/data/dates.json`: `Dates` IDs, `GeneratedAt`, `LatestForecastAt`, `LatestGaugeAt`.
- `shared/data/runs/Hidra_YYYYMMDDHH.json`: 30 forecasts.
- `shared/data/mareografKP_vodostaj.json`: gauge data.

Only a completely validated, credential-scanned bundle is renamed into the new `_site/` output. An existing output is never overwritten. Any failure prevents artifact upload/deployment, leaving the previous Pages deployment intact. Official `actions/upload-pages-artifact` and `actions/deploy-pages` publish the artifact; **no downloaded data is committed**. The secret is scoped to the download step, never substituted into HTML/JavaScript, manifests, logs or artifacts. The base URL is trusted operator configuration: only point it at the intended ARSO HTTPS gateway.

Browsers fetch these files from the same origin, not ARSO, so they need neither a key nor gateway CORS. Network, HTTP, JSON and plot failures show the localized error panel. A visible warning in both languages marks data stale if the bundle or gauge is older than 36 hours, or the latest forecast issue time is older than 36 hours; missing freshness metadata is stale too. The warning is reevaluated every minute on open pages. Stale but valid data remains visible. This page is not an official warning service or a sole source for safety decisions.

## Local verification

Python 3.8+ and Node.js 18+; no pip/npm dependencies:

```sh
python -m unittest discover -s tests -v
node tests/frontend-smoke.cjs
```

Tests use explicitly enabled loopback mock HTTP, synthetic data, and a fake clock: pagination, latest-30 selection, auth on every request, bounded retry/rate limiting, redirect refusal, secret-safe failures, JSON validation, atomic failure and isolated output. Node executes the actual app with local Moment and a minimal DOM/Plotly harness in both languages. It is a smoke test, not full browser rendering verification.

For a single **opt-in** authenticated endpoint check (one listing request only, not CI), set `ARSO_HYDRA_API_KEY` explicitly and run `python scripts/build_site.py --smoke-listing-only`. This does not read `arso.token`, enumerate pages, fetch forecasts or write an artifact.

For an authorized real build, provide the key through `ARSO_HYDRA_API_KEY` in your shell environment or secret manager and run:

```sh
python scripts/build_site.py --output _site
node tests/artifact-smoke.cjs _site
python -m http.server --directory _site 8000
```

Alternatively, an ignored private `arso.token` file may hold the key locally (restrict it to mode 600). Without displaying the key or putting it in shell history:

```sh
set +x
export ARSO_HYDRA_API_KEY="$(< arso.token)"
python scripts/build_site.py --output _site
unset ARSO_HYDRA_API_KEY
```

The token file is never used automatically or included in the build. Choose a fresh output directory for each build; do not serve the repository root. No authenticated gateway behavior can be proven **without a valid key**; offline fixtures do not establish account entitlement, upstream availability, or permission to redistribute data.

## Data permission assumption

Deploying this site makes the downloaded forecasts and measurements public in Pages and its artifact. **This implementation assumes your ARSO subscription/data terms permit redistribution. Confirm that authorization and attribution requirements with ARSO before activating publication.** Having an API key alone is not proof of redistribution rights. Retain the existing model references and ARSO attribution.
