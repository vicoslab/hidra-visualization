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
    for (const id of ['plot', 'plot-placeholder', 'error-placeholder', 'stale-warning', 'app-script']) {
      assert.ok(html.includes(`id="${id}"`), `missing ${id} in ${lang} artifact HTML`);
    }
    const elements = Object.fromEntries(['plot', 'plot-placeholder', 'error-placeholder', 'stale-warning', 'app-script'].map(id => [id, {
      style: {display: 'none'}, hidden: true, textContent: '',
      getAttribute: () => lang, on: () => {}, parentNode: {removeChild: () => {}}
    }]));
    let rendered;
    let requests = 0;
    const context = {
      document: {getElementById: id => elements[id]}, window: {}, console,
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
    assert.equal(requests, 32);
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
    console.log(`PASS ${lang}: ${predictions.length} forecasts, 72 finite mean/std points each; latest ${predictions.at(-1).date}; ${rendered.data[3].y.length} gauge observations`);
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
