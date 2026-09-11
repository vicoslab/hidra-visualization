// Historical selection through actual app code, both languages, on-demand months.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
(async () => {
 for (const lang of ['en','sl']) {
  const ids = Array.from({length:30},(_,i) => '202609'+String(i+1).padStart(2,'0')+'00');
  const old = '2020123100';
  const run = (date) => ({ForecastDate:date, Dates:Array(72).fill(date), Mean:Array(72).fill(201), Std:Array(72).fill(1.414214)});
  const requests = [];
  let rendered, fail = false;
  const elementIds = ['plot','plot-placeholder','error-placeholder','stale-warning','app-script','archive-date','archive-run','archive-status','latest-button'];
  const elements = Object.fromEntries(elementIds.map(id => [id, {value:'',style:{display:'none'},hidden:true,textContent:'',children:[],
    getAttribute:()=>lang, on:()=>{}, parentNode:{removeChild:()=>{}}, addEventListener:()=>{},
    replaceChildren(){this.children=[];}, appendChild(el){this.children.push(el);if(!this.value)this.value=el.value;}
  }]));
  const context = {document:{getElementById:id=>elements[id],createElement:()=>({})},window:{}, console, Date,Number,Promise,setInterval:()=>1,
   fetch:async url => {requests.push(url);return {ok:!fail,json:async()=>{
    if(url.endsWith('/dates.json'))return {Dates:ids, GeneratedAt:new Date().toISOString(),LatestForecastAt:new Date().toISOString(),LatestGaugeAt:new Date().toISOString()};
    if(url.endsWith('archive/index.json'))return {Version:1,Dates:[old,...ids],GaugeMonths:['202012','202101','202609']};
    if(url.includes('archive/runs/2020/12.json'))return {[old]:run('31.12.2020 00:00')};
    if(url.includes('archive/gauges/2020/12.json'))return {Dates:['31.12.2020 00:00'],Values:[198]};
    if(url.includes('archive/gauges/2021/01.json'))return {Dates:['01.01.2021 00:00'],Values:[199]};
    if(url.includes('/runs/'))return run('01.09.2026 00:00');
    return {Dates:['01.09.2026 00:00'],Values:[200]};
   }};}, Plotly:{newPlot:async(_,figure)=>{rendered=figure;}}
  };
  vm.createContext(context);
  for(const name of ['moment.min.js','localization.js','app.js'])vm.runInContext(fs.readFileSync(path.join(root,'shared/js',name),'utf8'),context);
  await context.window.onload();
  assert.equal(elements['error-placeholder'].style.display,'none');
  assert.equal(rendered.layout.sliders[0].steps.length,30);
  assert.equal(requests.length,33);
  assert.ok(!requests.some(u=>u.includes('archive/runs/')));
  assert.equal(typeof context.selectArchiveRun,'function','archive selector implementation missing');
  // Set actual forecast dates across a month boundary.
  const dates=Array.from({length:72},(_,i)=>context.moment('2020-12-31').add(i,'hours').format('DD.MM.YYYY HH:mm'));
  const originalFetch=context.fetch;
  context.fetch=async url=>{
    const response=await originalFetch(url);
    if(url.includes('archive/runs/'))return {ok:response.ok,json:async()=>({[old]:{...run('31.12.2020 00:00'),Dates:dates}})};
    return response;
  };
  await context.selectArchiveRun(old);
  assert.equal(rendered.data[0].x[0],'2020-12-31T00:00:00');
  assert.deepEqual(Array.from(rendered.data[3].y),[198,null,199]);
  assert.equal(rendered.layout.sliders.length,0,'hide misleading recent slider during history');
  assert.match(elements['archive-status'].textContent,/2020123100/);
  assert.ok(!requests.some(u=>u.includes('archive/gauges/2026/')));
  await context.showLatest();
  assert.equal(rendered.data[0].x[0],'2026-09-01T00:00:00');
  assert.equal(rendered.layout.sliders[0].steps.length,30);
  fail=true;
  await context.selectArchiveRun(old);
  assert.equal(elements['error-placeholder'].style.display,'block');
  const html=fs.readFileSync(path.join(root,lang,'index.html'),'utf8');
  for(const id of elementIds.slice(5))assert.ok(html.includes(`id="${id}"`));
 }
 console.log('PASS: historical month loading, cross-month gauges, latest-30 retained, both languages and error handling');
})().catch(e=>{console.error(e);process.exitCode=1;});
