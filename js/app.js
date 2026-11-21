import { AudioEngine } from './audio-engine.js';
import { Microphone } from './microphone.js';

const $ = (id) => document.getElementById(id);
const engine = new AudioEngine();
const mic = new Microphone();
let running = false, wakeLock = null, level = 0, peakHold = 0, raf = 0;

const el = {
  start: $('startBtn'), phones: $('phones'), status: $('status'), error: $('error'),
  pitch: $('pitch'), pitchVal: $('pitchVal'), formant: $('formant'), formantVal: $('formantVal'),
  monitor: $('monitor'), reset: $('resetBtn'), meter: $('meterFill'), peak: $('meterPeak'),
  db: $('dbVal'), latency: $('latency')
};

const fmt = (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1);
function showValues() {
  el.pitchVal.textContent = fmt(el.pitch.value) + ' 半音';
  el.formantVal.textContent = fmt(el.formant.value);
}
function setStatus(t) { el.status.textContent = t; }
function showError(t) { el.error.textContent = t || ''; el.error.hidden = !t; }

el.phones.addEventListener('change', () => { if (!running) el.start.disabled = !el.phones.checked; });

el.pitch.addEventListener('input', () => { showValues(); engine.setPitch(parseFloat(el.pitch.value)); });
el.formant.addEventListener('input', () => { showValues(); engine.setFormant(parseFloat(el.formant.value)); });
el.monitor.addEventListener('change', () => engine.setMonitor(el.monitor.checked));
el.reset.addEventListener('click', () => {
  el.pitch.value = 0; el.formant.value = 0; showValues();
  engine.setPitch(0); engine.setFormant(0);
});

el.start.addEventListener('click', () => (running ? stop() : start()));

async function start() {
  showError('');
  el.start.disabled = true;
  try {
    engine.pitch = parseFloat(el.pitch.value);
    engine.formant = parseFloat(el.formant.value);
    engine.monitor = el.monitor.checked;
    engine.prepare();                         // ← タップ内で同期的に実行 (iOS必須)
    const stream = await mic.start();
    mic.onEnded = () => { if (running) { stop(); showError('マイクが切断されました。'); } };
    engine.onLevel = (rms, peak) => { level = rms; peakHold = Math.max(peakHold, peak); };
    engine.onState = (s) => {
      if (!running) return;
      if (s === 'running') setStatus('処理中');
      else if (s === 'interrupted' || s === 'suspended') setStatus('一時停止中 (画面に戻ると再開します)');
    };
    await engine.start(stream);
    running = true;
    el.start.textContent = '停止';
    el.start.classList.add('stop');
    el.start.disabled = false;
    el.phones.disabled = true;
    setStatus('処理中');
    acquireWakeLock();
    loop();
  } catch (e) {
    console.error(e);
    mic.stop(); await engine.stop();
    el.start.disabled = !el.phones.checked;
    showError(e && e.name === 'NotAllowedError'
      ? 'マイクの使用が許可されていません。Safariの設定 > Webサイトでマイクを許可してください。'
      : '開始できませんでした: ' + (e && e.message ? e.message : e));
    setStatus('停止中');
  }
}

async function stop() {
  running = false;
  cancelAnimationFrame(raf);
  mic.stop();
  await engine.stop();
  releaseWakeLock();
  el.start.textContent = '開始';
  el.start.classList.remove('stop');
  el.start.disabled = !el.phones.checked;
  el.phones.disabled = false;
  el.meter.style.transform = 'scaleX(0)'; el.peak.style.left = '0%';
  el.db.textContent = '-∞ dB'; el.latency.textContent = '--';
  setStatus('停止中');
}

function dbToPos(db) { return Math.max(0, Math.min(1, (db + 60) / 60)); }
let lastLat = 0;
function loop(now = 0) {
  if (!running) return;
  const db = level > 1e-5 ? 20 * Math.log10(level) : -Infinity;
  const pos = dbToPos(db);
  el.meter.style.transform = 'scaleX(' + pos + ')';
  el.meter.classList.toggle('hot', peakHold > 0.9);
  const pdb = peakHold > 1e-5 ? 20 * Math.log10(peakHold) : -Infinity;
  el.peak.style.left = (dbToPos(pdb) * 100) + '%';
  el.db.textContent = isFinite(db) ? db.toFixed(0) + ' dB' : '-∞ dB';
  peakHold *= 0.96;
  if (now - lastLat > 1000) { lastLat = now; el.latency.textContent = '約 ' + engine.estimateLatencyMs() + ' ms'; }
  raf = requestAnimationFrame(loop);
}

// 画面ロック防止 (対応時のみ)
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }

// バックグラウンド復帰時に AudioContext を再開
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && running) {
    try { await engine.resume(); } catch (e) {}
    if (!wakeLock) acquireWakeLock();
    loop();
  }
});

showValues();
if (!window.isSecureContext) showError('HTTPSで開いてください (マイクはHTTPSでのみ使えます)。');
