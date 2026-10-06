import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(path.isAbsolute(target) ? pathToFileURL(target).href : target);
const artifacts = process.env.E2E_ARTIFACT_DIR || '/tmp/va-articulation-evidence';
await fs.mkdir(artifacts, { recursive: true });
const baseline = process.env.LIPSYNC_BASELINE_MODULE;

function html(legacy) {
  return `<!doctype html><html><head><style>
    html,body,#root{margin:0;width:100%;height:100%;background:#202733}
    canvas{display:block}
    </style></head><body><div id="root"></div><script type="module">
    import React, { Suspense } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Canvas, useLoader, useFrame } from '@react-three/fiber';
    import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
    import { Avatar } from '/src/components/Avatar.jsx';
    import { AudioLipSync } from '${legacy ? '/baseline-lips.js' : '/src/services/audioLipSync.js'}';
    const lip = new AudioLipSync();
    const emptyClips = [];
    const e = React.createElement;
    function RenderReady() { useFrame(() => { window.__renderFrames = (window.__renderFrames || 0) + 1; }); return null; }
    function Scene() {
      const model = useLoader(GLTFLoader, '/models/64bb1d39ab757f1e75aaa1aa.glb');
      window.__model = model;
      return e(Canvas, { camera:{position:[0,-0.23,6.35],fov:32}, dpr:1 },
        e(RenderReady),
        e('ambientLight',{intensity:1.5}), e('directionalLight',{position:[4,6,8],intensity:2.2}),
        e(Avatar,{audioLipSync:lip,model,idleAnimation:emptyClips,greetingAnimation:emptyClips,position:[0,-3.5,5],scale:2}));
    }
    window.__articulation = {
      lip,
      pose(viseme, rms, frames = 24) {
        lip.audioContext = {currentTime:0.5};
        lip.analyser = { getFloatTimeDomainData(data) {data.fill(rms);} };
        lip._waveformData = new Float32Array(64);
        lip._activeAudioItem = null;
        lip._audioStartCtxTime = 0;
        lip._playbackDuration = 1;
        lip._textTimeline = [{viseme, startFrac:0,endFrac:1}];
        for(let frame=0;frame<frames;frame++) {
          lip._lastFrameClock = performance.now()/1000 - 1/60;
          lip._analyzeFrame();
        }
        return {...lip.visemeWeights};
      },
      async speech() {
        lip.audioContext = null;
        lip.analyser = null;
        await lip.prepare();
        const response = await fetch('/voice.wav');
        const audio = await lip.audioContext.decodeAudioData(await response.arrayBuffer());
        const id = lip.beginPcm('Mom packed my blue paper bag. Five thin fish swim through the blue water.', {sampleRate:audio.sampleRate});
        const samples = audio.getChannelData(0);
        for(let i=0;i<samples.length;i+=4410) lip.enqueuePcm(samples.slice(i,i+4410),'',{speechId:id,sampleRate:audio.sampleRate});
        lip.finishPcm(id);
        return audio.duration;
      }
    };
    createRoot(document.getElementById('root')).render(e(Suspense,{fallback:null},e(Scene)));
  </script></body></html>`;
}

const vite = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [{
  name: 'articulation-fixture',
  resolveId(id) { if (id === '/baseline-lips.js' && baseline) return '\0baseline-lips'; },
  async load(id) {
    if (id === '\0baseline-lips') return (await fs.readFile(baseline, 'utf8')).replace('../utils/springDamper.js', '/src/utils/springDamper.js');
  },
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/articulation.html')) {
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml(req.url, html(req.url.includes('baseline'))));
      } else if (req.url === '/voice.wav' && process.env.LIPSYNC_VOICE_SAMPLE) {
        res.setHeader('Content-Type', 'audio/wav');
        res.end(await fs.readFile(process.env.LIPSYNC_VOICE_SAMPLE));
      } else next();
    });
  },
}] });
let browser;
const results = {};
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const legacy of baseline ? [true, false] : [false]) {
    const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/articulation.html${legacy ? '?baseline' : ''}`);
    await page.waitForFunction(() => window.__model && window.__renderFrames >= 3);
    const capture = async (viseme, rms, name, frames = 24) => {
      const weights = await page.evaluate(({ viseme, rms, frames }) => window.__articulation.pose(viseme, rms, frames), { viseme, rms, frames });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const head = await page.evaluate(() => {
        const mesh = window.__model.nodes.Wolf3D_Head;
        return Object.fromEntries(Object.entries(mesh.morphTargetDictionary).filter(([key]) => key.startsWith('viseme_')).map(([key, index]) => [key, mesh.morphTargetInfluences[index]]));
      });
      await page.screenshot({ path: path.join(artifacts, `${legacy ? 'before' : 'after'}-${name}.png`) });
      return { weights, head };
    };
    await capture('viseme_aa', 0.14, 'open');
    const closure = await capture('viseme_PP', 0.0001, 'closure', 4);
    results[legacy ? 'before' : 'after'] = closure;
    if (!legacy) {
      assert.ok(closure.head.viseme_PP > 0.9, 'the rendered head must seal its lips for quiet P/B/M');
      assert.ok(closure.head.viseme_aa < 0.04, 'the preceding open vowel must not bleed into closure');
      for (const [viseme, name] of [['viseme_FF', 'ff'], ['viseme_TH', 'th'], ['viseme_O', 'rounded']]) await capture(viseme, 0.12, name);
      if (process.env.LIPSYNC_VOICE_SAMPLE) {
        await page.evaluate(() => window.__articulation.speech());
        await page.waitForFunction(() => window.__articulation.lip.queue.some((item) => item.alignedTimeline?.length));
        results.live = await page.evaluate(() => {
          const item = window.__articulation.lip.queue[0];
          return { duration: item.receivedDuration, phonemes: item.textTimeline.length,
            aligned: item.alignedTimeline, speechStart: item.alignedTimeline[0].start,
            speechEnd: item.alignedTimeline.at(-1).end };
        });
        await page.screenshot({ path: path.join(artifacts, 'after-real-speech.png') });
      }
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  if (results.before) {
    assert.ok(results.after.head.viseme_PP > results.before.head.viseme_PP + 0.5);
    assert.ok(results.after.head.viseme_aa < results.before.head.viseme_aa / 4);
  }
  await fs.writeFile(path.join(artifacts, 'articulation-results.json'), JSON.stringify(results, null, 2));
  console.log('ok - rendered consonant closure, vowel release and distinct mouth poses');
} finally {
  await browser?.close();
  await vite.close();
}
