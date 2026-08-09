import { chromium } from '/private/tmp/claude-501/-Users-michaeldewet/d57130d3-0a66-4c81-ae2e-521dfc2ed8aa/scratchpad/node_modules/playwright/index.mjs';
const OUT='/private/tmp/claude-501/-Users-michaeldewet/d57130d3-0a66-4c81-ae2e-521dfc2ed8aa/scratchpad';
const b = await chromium.launch({ channel:'chrome', args:['--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport:{width:900,height:800} });
await p.goto('http://localhost:8777/index.html');
await p.waitForTimeout(1200);
await p.click('.btn-mode[data-mode="liquid"]');
await p.evaluate(() => { const s=window.__soundform;
  s.params.background='#aeb8bf'; s.params.colorPrimary='#12181d'; s.params.colorSecondary='#7d94a6';
  const st = Object.assign(s.idleState(), s.targetFromFeatures(
    { pitchNorm:0.28, rms:0.4, centroid:0.35, spread:0.12, pitchConf:0.95 }));
  s.setField(st, 'material'); });
await p.waitForTimeout(1000);
await p.screenshot({ path:`${OUT}/H-a.png`, clip:{x:0,y:40,width:640,height:700} });
await p.waitForTimeout(1500);
await p.screenshot({ path:`${OUT}/H-b.png`, clip:{x:0,y:40,width:640,height:700} });
console.log('captured hold pair');
await b.close();
