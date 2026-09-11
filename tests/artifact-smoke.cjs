// Exercise the real frontend against a downloaded site artifact, without a browser.
// Usage: node tests/artifact-smoke.cjs _site
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(process.argv[2] || '_site');
(async () => {
  for (const lang of ['en', 'sl']) {
    const html = fs.readFileSync(path.join(root, lang, 'index.html'), 'utf8');
    for (const id of ['plot', 'plot-placeholder', 'error-placeholder', 'stale-warning', 'app-script', 'archive-date', 'archive-run', 'archive-status', 'latest-button']) {
      assert.ok(html.includes(`id="${id}"`), `missing ${id} in ${lang} artifact HTML`);
    }
    const elements = Object.fromEntries(['plot', 'plot-placeholder', 'error-placeholder', 'stale-warning', 'app-script', 'archive-date', 'archive-run', 'archive-status', 'latest-button'].map(id => [id, {
      style: {display: 'none'}, hidden: true, textContent: '',
      getAttribute: () => lang, on: () => {}, parentNode: {removeChild: () => {}},
      addEventListener: () => {}, replaceChildren: () => {}, appendChild: () => {}
    }]));
    let rendered;
    let requests = 0;
    const context = {
      document: {getElementById: id => elements[id], createElement: () => ({})}, window: {}, console,
      Date, Number, Promise, setInterval: () => 1,
      fetch: async url => {
        assert.match(url, /^\.\.\/shared\/data\//);
        requests++;
        return {ok: true, json: async () => JSON.parse(fs.readFileSync(path.resolve(root, lang, url), 'utf8'))};
      },
      Plotly: {newPlot: async (_, figure) => { rendered = figure; }}
    };
    vm.createContext(context);
    for (const name of ['moment.min.js', 'localization.js', 'app.js']) {
      vm.runInContext(fs.readFileSync(path.join(root, 'shared/js', name), 'utf8'), context);
    }
    await context.window.onload();
    assert.ok(rendered, 'frontend must create a plot');
    assert.equal(elements['error-placeholder'].style.display, 'none');
    const predictions = context.app.data.predictions;
    assert.equal(predictions.length, 30);
    assert.equal(requests, 33);
    for (const prediction of predictions) {
      assert.equal(prediction.x.length, 72);
      assert.equal(prediction.y.length, 72);
      assert.equal(prediction.stddev.length, 72);
      assert.ok(prediction.x.every(value => Number.isFinite(Date.parse(value))));
      assert.ok(prediction.y.every(Number.isFinite));
      assert.ok(prediction.stddev.every(value => Number.isFinite(value) && value >= 0));
    }
    assert.equal(rendered.data.length, 4);
    assert.ok(rendered.data[3].y.length > 0);
    const archive = JSON.parse(fs.readFileSync(path.join(root, 'shared/data/archive/index.json'), 'utf8'));
    const selected = [...new Set([archive.Dates[0], archive.Dates[Math.floor(archive.Dates.length / 2)], archive.Dates.at(-1)])];
    for (const id of selected) {
      await context.selectArchiveRun(id);
      assert.equal(elements['error-placeholder'].style.display, 'none', `failed historical ${id}`);
      const month = JSON.parse(fs.readFileSync(path.join(root, 'shared/data/archive/runs', id.slice(0,4), id.slice(4,6)+'.json'), 'utf8'));
      assert.deepEqual(Array.from(rendered.data[0].y), month[id].Mean);
      assert.equal(rendered.data[0].x.length, 72);
      assert.ok(rendered.data[0].x.every(v => Number.isFinite(Date.parse(v))));
      assert.ok(rendered.data[1].y.every(Number.isFinite));
      assert.ok(rendered.data[2].y.every(Number.isFinite));
      assert.ok(rendered.data[3].y.every(v => v === null || Number.isFinite(v)));
      assert.equal(rendered.layout.sliders.length, 0);
      assert.ok(elements['archive-status'].textContent.includes(id));
    }
    await context.showLatest();
    assert.equal(rendered.layout.sliders[0].active, 29);
    assert.deepEqual(Array.from(rendered.data[0].y), Array.from(predictions.at(-1).y));
    console.log(`PASS ${lang}: 30 latest forecasts and historical IDs ${selected.join(', ')}; ${archive.Dates.length} archive runs; finite curves and return to latest`);
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
