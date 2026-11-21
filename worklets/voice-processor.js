/**
 * voice-processor.js — AudioWorklet
 * STFT フェーズボコーダ + ケプストラム包絡によるピッチ/フォルマント独立変換
 *
 * 1) FFT → 振幅/位相
 * 2) ケプストラム・リフタリングでスペクトル包絡(声道特性)を推定
 * 3) 振幅を「包絡で割った励振成分」にして、ピッチ比でビン再配置 (Laroche-Dolson 風 位相ロック)
 * 4) 包絡だけをフォルマント比で周波数軸方向に伸縮して掛け直す
 * 5) IFFT → 窓掛け → オーバーラップ加算
 * ピッチだけ動かしても声道特性(包絡)は元のまま、フォルマントだけ動かしても基本周波数は元のまま。
 */
const N = 2048;            // FFTサイズ
const HOP = 512;           // ホップ (75% overlap)
const HALF = N >> 1;
const TWO_PI = Math.PI * 2;
const OMEGA = TWO_PI * HOP / N;   // 1ホップあたり・1ビンあたりの位相進み
const OUT_SCALE = 1 / 1.5;        // Hann^2 を 75% overlap で加算した時の定数

class FFT {
  constructor(n) {
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(TWO_PI * i / n);
      this.sin[i] = Math.sin(TWO_PI * i / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
  }
  transform(re, im, inverse) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const wr = cs[k], wi = inverse ? sn[k] : -sn[k];
          const l = j + half;
          const tr = re[l] * wr - im[l] * wi;
          const ti = re[l] * wi + im[l] * wr;
          re[l] = re[j] - tr; im[l] = im[j] - ti;
          re[j] += tr; im[j] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

class VoiceProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fft = new FFT(N);
    this.win = new Float64Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / N);

    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.mag = new Float64Array(HALF + 1);
    this.ph = new Float64Array(HALF + 1);
    this.prevPh = new Float64Array(HALF + 1);
    this.trueBin = new Float64Array(HALF + 1);
    this.logEnv = new Float64Array(HALF + 1);
    this.flat = new Float64Array(HALF + 1);
    this.peaks = new Int32Array(HALF + 1);
    this.peakOf = new Int32Array(HALF + 1);
    this.peakTheta = new Float64Array(HALF + 1);
    this.peakStamp = new Int32Array(HALF + 1);
    this.thetaPrev = new Float64Array(HALF + 1);
    this.thetaOut = new Float64Array(HALF + 1);
    this.frameId = 0;

    this.lifter = Math.max(20, Math.min(200, Math.round(sampleRate * 0.002)));

    this.inBuf = new Float32Array(N);
    this.outAcc = new Float32Array(N);
    this.fifo = new Float32Array(HOP * 8);
    this.fifoR = 0; this.fifoW = 0; this.fifoCount = 0;
    this.sinceFrame = 0;

    this.pitchTarget = 0; this.formantTarget = 0;
    this.pitchCur = 0; this.formantCur = 0;
    this.active = true;

    this.meterSum = 0; this.meterPeak = 0; this.meterCount = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'params') {
        this.pitchTarget = Math.max(-12, Math.min(12, m.pitch));
        this.formantTarget = Math.max(-6, Math.min(6, m.formant));
      } else if (m.type === 'active') {
        if (m.value && !this.active) this.reset();
        this.active = !!m.value;
      }
    };
    this.port.postMessage({ type: 'ready', frame: N, hop: HOP });
  }

  reset() {
    this.inBuf.fill(0); this.outAcc.fill(0);
    this.prevPh.fill(0); this.thetaPrev.fill(0);
    this.fifoR = this.fifoW = this.fifoCount = 0;
    this.sinceFrame = 0;
  }

  processFrame() {
    const { re, im, mag, ph, prevPh, trueBin, logEnv, flat, peaks, peakOf,
            peakTheta, peakStamp, thetaPrev, thetaOut, win, fft } = this;

    // パラメータ平滑化 (半音→比)
    this.pitchCur += (this.pitchTarget - this.pitchCur) * 0.35;
    this.formantCur += (this.formantTarget - this.formantCur) * 0.35;
    const pr = Math.pow(2, this.pitchCur / 12);      // ピッチ比
    const fr = Math.pow(2, this.formantCur / 12);    // フォルマント比 (±6 → ±半オクターブ)

    // 1) 解析
    for (let i = 0; i < N; i++) { re[i] = this.inBuf[i] * win[i]; im[i] = 0; }
    fft.transform(re, im, false);
    for (let k = 0; k <= HALF; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      ph[k] = Math.atan2(im[k], re[k]);
    }

    // 2) 瞬時周波数
    for (let k = 0; k <= HALF; k++) {
      let d = ph[k] - prevPh[k] - OMEGA * k;
      d -= TWO_PI * Math.round(d / TWO_PI);
      trueBin[k] = k + d / OMEGA;
      prevPh[k] = ph[k];
    }

    // 3) ケプストラム包絡 (最大値の-60dBをフロアにして谷の落ち込みを抑える)
    let mx = 0;
    for (let k = 0; k <= HALF; k++) if (mag[k] > mx) mx = mag[k];
    const floor = Math.max(1e-9, mx * 1e-3);
    for (let k = 0; k <= HALF; k++) {
      const v = Math.log(mag[k] + floor);
      re[k] = v; im[k] = 0;
      if (k > 0 && k < HALF) { re[N - k] = v; im[N - k] = 0; }
    }
    fft.transform(re, im, true);                       // → ケプストラム
    const L = this.lifter;
    for (let n = L; n <= N - L; n++) { re[n] = 0; im[n] = 0; }
    fft.transform(re, im, false);                      // → 平滑化 log 包絡
    for (let k = 0; k <= HALF; k++) {
      logEnv[k] = re[k];
      flat[k] = mag[k] / Math.exp(re[k]);              // 励振(声帯)成分
    }

    // 4) ピーク検出と領域割り当て (位相ロック用)
    let pc = 0;
    for (let k = 2; k < HALF - 2; k++) {
      const m = mag[k];
      if (m > mag[k - 1] && m > mag[k - 2] && m >= mag[k + 1] && m >= mag[k + 2]) peaks[pc++] = k;
    }
    if (pc === 0) { peaks[0] = 1; pc = 1; }
    let idx = 0;
    for (let k = 0; k <= HALF; k++) {
      while (idx + 1 < pc && k > ((peaks[idx] + peaks[idx + 1]) >> 1)) idx++;
      peakOf[k] = peaks[idx];
    }

    // 5) ピークの位相を累積 (ピッチ比で周波数スケール)
    this.frameId++;
    const fid = this.frameId;
    for (let q = 0; q < pc; q++) {
      const p = peaks[q];
      const jp = Math.round(p * pr);
      if (jp > HALF) continue;
      peakTheta[jp] = thetaPrev[jp] + OMEGA * trueBin[p] * pr;
      peakStamp[jp] = fid;
    }

    // 6) 出力スペクトル構築 (ターゲットビン主導)
    for (let j = 0; j <= HALF; j++) {
      const src = j / pr;
      let th;
      const kn = Math.min(HALF, Math.round(src));
      const p = peakOf[kn];
      const jp = Math.round(p * pr);
      if (jp <= HALF && peakStamp[jp] === fid) {
        th = peakTheta[jp] + (j === jp ? 0 : ph[kn] - ph[p]);
      } else {
        th = thetaPrev[j] + OMEGA * j;
      }
      thetaOut[j] = th;

      // 励振の振幅 (線形補間)
      let fl = 0;
      if (src <= HALF) {
        const k0 = Math.floor(src), fr0 = src - k0;
        fl = k0 < HALF ? flat[k0] * (1 - fr0) + flat[k0 + 1] * fr0 : flat[HALF] * (1 - fr0);
      }
      // 包絡 (フォルマント比で周波数軸を伸縮)
      let es = j / fr;
      if (es > HALF) es = HALF;
      const e0 = Math.floor(es), e1 = Math.min(e0 + 1, HALF), ef = es - e0;
      const le = logEnv[e0] * (1 - ef) + logEnv[e1] * ef;
      const m = fl * Math.exp(le);

      re[j] = m * Math.cos(th);
      im[j] = m * Math.sin(th);
      if (j > 0 && j < HALF) { re[N - j] = re[j]; im[N - j] = -im[j]; }
    }
    im[0] = 0; im[HALF] = 0;
    thetaPrev.set(thetaOut);

    // 7) 合成
    fft.transform(re, im, true);
    const acc = this.outAcc;
    let bad = false;
    for (let i = 0; i < N; i++) {
      const v = re[i] * win[i] * OUT_SCALE;
      if (v !== v) { bad = true; break; }
      acc[i] += v;
    }
    if (bad) { this.reset(); return; }

    for (let i = 0; i < HOP; i++) {
      this.fifo[this.fifoW] = acc[i];
      this.fifoW = (this.fifoW + 1) % this.fifo.length;
    }
    this.fifoCount += HOP;
    acc.copyWithin(0, HOP);
    acc.fill(0, N - HOP);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const inp = inputs[0] && inputs[0][0];
    const len = out[0].length;

    if (!inp) {
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }

    // 入力レベル
    let sum = 0, pk = 0;
    for (let i = 0; i < len; i++) { const a = Math.abs(inp[i]); sum += inp[i] * inp[i]; if (a > pk) pk = a; }
    this.meterSum += sum; this.meterCount += len; if (pk > this.meterPeak) this.meterPeak = pk;
    if (this.meterCount >= sampleRate * 0.05) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.meterSum / this.meterCount), peak: this.meterPeak });
      this.meterSum = 0; this.meterCount = 0; this.meterPeak = 0;
    }

    if (!this.active) {                  // モニターOFF時はDSPを止めて発熱を抑える
      for (let c = 0; c < out.length; c++) out[c].fill(0);
      return true;
    }

    this.inBuf.copyWithin(0, len);
    this.inBuf.set(inp, N - len);
    this.sinceFrame += len;
    while (this.sinceFrame >= HOP) { this.sinceFrame -= HOP; this.processFrame(); }

    const o0 = out[0];
    for (let i = 0; i < len; i++) {
      let v = 0;
      if (this.fifoCount > 0) {
        v = this.fifo[this.fifoR];
        this.fifoR = (this.fifoR + 1) % this.fifo.length;
        this.fifoCount--;
      }
      o0[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
    for (let c = 1; c < out.length; c++) out[c].set(o0);
    return true;
  }
}

registerProcessor('voice-processor', VoiceProcessor);
