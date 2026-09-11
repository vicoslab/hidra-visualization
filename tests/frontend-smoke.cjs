// No dependencies: run real app code in a small browser/Plotly harness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const run = {
  ForecastDate: '01.09.2026 12:00',
  Dates: Array.from({length: 72}, () => '01.09.2026 12:00'),
  Hidra: [{values: Array(72).fill(200), std: Array(72).fill(1)}]
};
async function check(lang, failure = null, stale = false) {
  const elements = Object.fromEntries(['plot', 'plot-placeholder', 'error-placeholder', 'stale-warning', 'app-script', 'archive-date', 'archive-run', 'archive-status', 'latest-button'].map(id => [id, {
    style: {display: 'none'}, hidden: true, textContent: '',
    getAttribute: () => lang, on: () => {}, parentNode: {removeChild: () => {}},
      addEventListener: () => {}, replaceChildren: () => {}, appendChild: () => {}
  }]));
  const requests = [];
  let plots = 0;
  const context = {
    document: {getElementById: id => elements[id], createElement: () => ({})}, window: {}, console,
    Date, Number, Promise, setInterval: () => 1,
    fetch: async url => {
      requests.push(url);
      assert.match(url, /^\.\.\/shared\/data\//);
      if (failure === 'network') throw new Error('offline');
      return {ok: failure !== 'http', json: async () => {
        if (failure === 'json') throw new Error('invalid JSON');
        if (url.endsWith('dates.json')) return {Dates: ['2026090112'], GeneratedAt: stale ? '2000-01-01T00:00:00Z' : new Date().toISOString(), LatestForecastAt: stale ? '2000-01-01T00:00:00Z' : new Date().toISOString(), LatestGaugeAt: new Date().toISOString()};
        if (url.endsWith('archive/index.json')) return {Version: 1, Dates: ['2026090112'], GaugeMonths: ['202609']};
        if (url.includes('/runs/')) return run;
        return {Dates: ['01.09.2026 12:00'], Values: [200]};
      }};
    },
    Plotly: {newPlot: async () => { plots++; if (failure === 'plot') throw new Error('plot failed'); }}
  };
  vm.createContext(context);
  for (const name of ['moment.min.js', 'localization.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'shared/js', name), 'utf8'), context);
  }
  await context.window.onload();
  assert.ok(requests.length > 0);
  if (failure) assert.equal(elements['error-placeholder'].style.display, 'block');
  else {
    assert.equal(plots, 1);
    assert.equal(requests.length, 4);
    if (stale) {
      assert.equal(elements['stale-warning'].hidden, false);
      assert.match(elements['stale-warning'].textContent, lang === 'en' ? /out of date/i : /zastareli/i);
    }
  }
}
(async () => {
  for (const lang of ['en', 'sl']) {
    const html = fs.readFileSync(path.join(root, lang, 'index.html'), 'utf8');
    assert.match(html, /id="stale-warning"/);
    await check(lang);
    await check(lang, null, true);
    for (const failure of ['network', 'http', 'json', 'plot']) await check(lang, failure);
  }
  console.log('PASS: both languages, same-origin requests, fresh/stale data, network/HTTP/JSON/plot failures');
})().catch(error => { console.error(error); process.exitCode = 1; });
