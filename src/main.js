import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import * as Tone from 'tone';
import './style.css';

// ---------- Config (env placeholders fall back to public NASA endpoints) ----------
const env = (k, d) => { const v = import.meta.env[k]; return !v || /your_|placeholder/i.test(v) ? d : v; };
const CFG = {
  wmts: env('VITE_GIBS_WMTS_URL', 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'),
  wms: env('VITE_GIBS_WMS_URL', 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi'),
  stac: env('VITE_VEDA_STAC_URL', 'https://openveda.cloud/api/stac'),
};
const LAYERS = {
  truecolor: { id: 'MODIS_Terra_CorrectedReflectance_TrueColor', tms: 'GoogleMapsCompatible_Level9', z: 9, ext: 'jpg', label: 'True colour (MODIS Terra)' },
  lst: { id: 'MODIS_Terra_Land_Surface_Temp_Day', tms: 'GoogleMapsCompatible_Level7', z: 7, ext: 'png', label: 'Land surface temperature' },
  chl: { id: 'MODIS_Terra_Chlorophyll_A', tms: 'GoogleMapsCompatible_Level7', z: 7, ext: 'png', label: 'Ocean chlorophyll-a' },
  cloud: { id: 'MODIS_Terra_Cloud_Top_Temp_Day', tms: 'GoogleMapsCompatible_Level6', z: 6, ext: 'png', label: 'Cloud top temperature' },
};
const SCALES = { pentatonic: [0, 2, 4, 7, 9], dorian: [0, 2, 3, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10], chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const STORIES = [
  { t: 'Amazon smoke season (Aug 2019)', layer: 'truecolor', date: '2019-08-21', c: [-9, -60], z: 5, scale: 'aeolian' },
  { t: 'European heatwave (Jul 2019)', layer: 'lst', date: '2019-07-25', c: [47, 5], z: 4, scale: 'dorian' },
  { t: 'Baltic Sea bloom season (Jul 2020)', layer: 'chl', date: '2020-07-10', c: [58, 20], z: 5, scale: 'pentatonic' },
];
const $ = (id) => document.getElementById(id);

// ---------- Map ----------
const map = L.map('map', { minZoom: 2, maxZoom: 9, worldCopyJump: true }).setView([20, 0], 2);
let tiles;
function setLayer() {
  const l = LAYERS[$('layer').value];
  if (tiles) map.removeLayer(tiles);
  tiles = L.tileLayer(`${CFG.wmts}/${l.id}/default/${$('date').value}/${l.tms}/{z}/{y}/{x}.${l.ext}`,
    { maxNativeZoom: l.z, attribution: 'Imagery: NASA GIBS' }).addTo(map);
}

// ---------- UI init ----------
for (const [k, v] of Object.entries(LAYERS)) $('layer').add(new Option(v.label, k));
const d = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
$('date').value = d; $('date').max = d;
STORIES.forEach((s) => {
  const b = document.createElement('button'); b.textContent = s.t;
  b.onclick = () => {
    $('layer').value = s.layer; $('date').value = s.date; $('scale').value = s.scale; NOTES = buildNotes();
    map.setView(s.c, s.z); setLayer(); refresh();
  };
  $('stories').append(b);
});
fetch(`${CFG.stac}/collections`).then((r) => r.json())
  .then((j) => { $('stac').textContent = `VEDA STAC online · ${j.collections?.length ?? '?'} collections`; })
  .catch(() => { $('stac').textContent = 'VEDA STAC unreachable'; });

// ---------- Data pipeline (Web Worker): GIBS image -> pixels -> per-column features ----------
let cols = [], loadId = 0, timer;
const setStatus = (t) => { $('status').textContent = t; };
const refresh = () => { clearTimeout(timer); timer = setTimeout(loadData, 350); };

const worker = new Worker(new URL('./extract.worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id); if (!p) return; pending.delete(data.id);
  data.error ? p.rej(new Error(data.error)) : p.res(data);
};
const extractInWorker = (id, url, W, H) => new Promise((res, rej) => { pending.set(id, { res, rej }); worker.postMessage({ id, url, W, H }); });

async function loadData() {
  const id = ++loadId, l = LAYERS[$('layer').value], date = $('date').value;
  setStatus('Fetching GIBS imagery…');
  const sz = map.getSize(), W = 160, H = Math.max(24, Math.round((W * sz.y) / sz.x));
  const b = map.getBounds(), a = L.CRS.EPSG3857.project(b.getSouthWest()), c = L.CRS.EPSG3857.project(b.getNorthEast());
  const q = new URLSearchParams({
    version: '1.3.0', service: 'WMS', request: 'GetMap', layers: l.id, styles: '', format: 'image/png',
    transparent: 'false', crs: 'EPSG:3857', bbox: [a.x, a.y, c.x, c.y].join(','), width: W, height: H, time: date,
  });
  try {
    const r = await extractInWorker(id, `${CFG.wms}?${q}`, W, H);
    if (id !== loadId) return;
    const f = r.feat;
    cols = Array.from({ length: r.W }, (_, x) => {
      const o = x * 8;
      return { bands: [{ l: f[o], s: f[o + 1] }, { l: f[o + 2], s: f[o + 3] }, { l: f[o + 4], s: f[o + 5] }], c: f[o + 6], m: f[o + 7] };
    });
    if (col >= cols.length) col = 0;
    setStatus(`Ready · ${W} columns · ${l.label} · ${date}`);
  } catch (e) { cols = []; setStatus(`Could not load data: ${e.message}`); }
}

// ---------- Audio: synth -> filter -> delay -> panner -> compressor -> volume ----------
const synth = new Tone.PolySynth(Tone.Synth, {
  maxPolyphony: 12, oscillator: { type: 'triangle' },
  envelope: { attack: 0.02, decay: 0.15, sustain: 0.3, release: 0.9 },
});
const filter = new Tone.Filter(2000, 'lowpass');
const delay = new Tone.FeedbackDelay('8n', 0.3); delay.wet.value = 0.25;
const panner = new Tone.Panner(0);
const comp = new Tone.Compressor(-24, 4);
const vol = new Tone.Volume(-6);
synth.chain(filter, delay, panner, comp, vol, Tone.getDestination());
const analyser = new Tone.Analyser('fft', 64); vol.connect(analyser);
// AudioWorklet safety limiter, spliced in after the compressor. Falls back to compressor-only if unsupported.
(async () => {
  try {
    const tctx = Tone.getContext();
    await tctx.addAudioWorkletModule(`${import.meta.env.BASE_URL}limiter.worklet.js`);
    const node = tctx.createAudioWorkletNode('safety-limiter', { outputChannelCount: [2] });
    node.port.onmessage = ({ data }) => { $('peak').value = data.peak; };
    comp.disconnect(vol); Tone.connect(comp, node); Tone.connect(node, vol);
  } catch (e) { console.warn('AudioWorklet unavailable; using compressor only', e); }
})();

const buildNotes = () => {
  const s = SCALES[$('scale').value], out = [];
  for (let m = 36; m <= 84; m++) if (s.includes(m % 12)) out.push(Tone.Frequency(m, 'midi').toFrequency());
  return out; // scale-quantized frequency table (C2..C6)
};
let NOTES = buildNotes();
const speed = () => +$('speed').value;

function playCol(x, time, only = null) {
  const c = cols[x]; if (!c) return;
  panner.pan.setValueAtTime((x / Math.max(1, cols.length - 1)) * 2 - 1, time); // stereo position = map x
  filter.frequency.setValueAtTime(300 + c.c * 5000, time);                     // edge contrast = brightness of timbre
  const half = NOTES.length >> 1, off = [half, half >> 1, 0];                  // top of map = high register
  const dur = Math.max(0.15, Math.min(0.6, 1.5 / speed())), seen = new Set();
  c.bands.forEach((b, i) => {
    if ((only !== null && only !== i) || b.l < 0.03) return;                   // near-black = no data = silence
    const idx = Math.min(NOTES.length - 1, off[i] + Math.floor(b.l * half));   // luminance -> scale degree
    if (seen.has(idx)) return; seen.add(idx);
    synth.triggerAttackRelease(NOTES[idx], dur, time, 0.25 + 0.5 * b.s);       // saturation -> velocity
  });
}

// ---------- Scan mode ----------
let col = 0, playing = false;
const describe = (x) => {
  const m = cols[x]?.m ?? 0;
  const pos = x < cols.length / 3 ? 'left' : x > (2 * cols.length) / 3 ? 'right' : 'centre';
  return `Scanning ${pos} of map, brightness ${m > 0.66 ? 'high' : m > 0.33 ? 'medium' : 'low'}`;
};
const loop = new Tone.Loop((time) => {
  if (!cols.length) return;
  const x = col; playCol(x, time);
  Tone.getDraw().schedule(() => {
    $('scan').style.left = `${(x / cols.length) * 100}%`;
    if (x % 20 === 0) $('live').textContent = describe(x);
  }, time);
  col = (col + 1) % cols.length;
}, 0.125);

async function togglePlay() {
  await Tone.start();
  playing = !playing;
  if (playing && $('mode').value === 'scan') { loop.start(0); Tone.getTransport().start(); }
  else { loop.stop(); Tone.getTransport().stop(); playing = false; }
  $('play').setAttribute('aria-pressed', playing);
  $('play').textContent = playing ? '⏸ Pause scan' : '▶ Play scan';
}
$('play').onclick = togglePlay;
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); togglePlay(); } });

// ---------- Cursor mode ----------
let last = 0;
map.on('mousemove click', async (e) => {
  if ($('mode').value !== 'cursor' || !cols.length) return;
  if (e.type === 'click') await Tone.start();
  if (Tone.getContext().state !== 'running') return;
  const now = performance.now(); if (e.type === 'mousemove' && now - last < 90) return; last = now;
  const s = map.getSize(), p = e.containerPoint;
  const x = Math.min(cols.length - 1, Math.max(0, Math.floor((p.x / s.x) * cols.length)));
  playCol(x, Tone.now(), Math.min(2, Math.floor((p.y / s.y) * 3)));
});

// ---------- Controls ----------
$('mode').onchange = () => {
  if (playing) togglePlay();
  $('scan').hidden = $('mode').value !== 'scan';
  $('play').disabled = $('mode').value !== 'scan';
};
$('scale').onchange = () => { NOTES = buildNotes(); };
$('speed').oninput = () => { loop.interval = 1 / speed(); };
$('volume').oninput = () => { const v = +$('volume').value; vol.volume.value = v ? Tone.gainToDb(v) : -Infinity; };
$('layer').onchange = $('date').onchange = () => { setLayer(); refresh(); };
map.on('moveend', refresh);
$('mode').onchange(); $('speed').oninput(); $('volume').oninput();

// ---------- Visualiser ----------
const cv = $('viz'), ctx = cv.getContext('2d');
(function draw() {
  const v = analyser.getValue(), w = cv.width / v.length;
  ctx.clearRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#7cc4ff';
  v.forEach((db, i) => { const h = Math.max(0, (db + 100) / 100) * cv.height; ctx.fillRect(i * w, cv.height - h, w - 1, h); });
  requestAnimationFrame(draw);
})();

setLayer(); refresh();
