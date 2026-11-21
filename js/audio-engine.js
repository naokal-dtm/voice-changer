// Web Audio グラフ: マイク → AudioWorklet(voice-processor) → モニターGain → 出力
export class AudioEngine {
  constructor() {
    this.ctx = null; this.source = null; this.node = null; this.monitorGain = null;
    this.pitch = 0; this.formant = 0; this.monitor = true;
    this.frame = 2048;
    this.onLevel = null; this.onState = null;
  }

  // ★ユーザー操作(タップ)の同期区間で呼ぶ: AudioContext生成と resume()
  prepare() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio API に対応していません。');
    this.ctx = new AC({ latencyHint: 'interactive' });   // sampleRate は端末に任せる
    this.ctx.onstatechange = () => this.onState && this.onState(this.ctx.state);
    this.resumePromise = this.ctx.resume();
  }

  async start(stream) {
    await this.resumePromise;
    if (!this.ctx.audioWorklet) throw new Error('AudioWorklet に対応していません (iOS 14.5以降が必要)。');
    await this.ctx.audioWorklet.addModule('worklets/voice-processor.js');

    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'voice-processor', {
      numberOfInputs: 1, numberOfOutputs: 1,
      channelCount: 1, channelCountMode: 'explicit',
      outputChannelCount: [1]
    });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'level' && this.onLevel) this.onLevel(m.rms, m.peak);
      else if (m.type === 'ready') this.frame = m.frame;
    };
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = this.monitor ? 1 : 0;

    this.source.connect(this.node);
    this.node.connect(this.monitorGain);
    this.monitorGain.connect(this.ctx.destination);

    this.sendParams();
    this.node.port.postMessage({ type: 'active', value: this.monitor });
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  sendParams() {
    if (this.node) this.node.port.postMessage({ type: 'params', pitch: this.pitch, formant: this.formant });
  }
  setPitch(v) { this.pitch = v; this.sendParams(); }
  setFormant(v) { this.formant = v; this.sendParams(); }

  setMonitor(on) {
    this.monitor = on;
    if (!this.node) return;
    this.monitorGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
    this.node.port.postMessage({ type: 'active', value: on });   // OFF中はDSPを停止
  }

  resume() { return this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed' ? this.ctx.resume() : Promise.resolve(); }

  // 概算の総遅延 (ms): アルゴリズム遅延 + 出力系
  estimateLatencyMs() {
    if (!this.ctx) return 0;
    const out = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return Math.round((this.frame / this.ctx.sampleRate + out) * 1000);
  }

  async stop() {
    try { this.source && this.source.disconnect(); } catch (e) {}
    try { this.node && this.node.disconnect(); } catch (e) {}
    try { this.monitorGain && this.monitorGain.disconnect(); } catch (e) {}
    if (this.node) this.node.port.onmessage = null;
    if (this.ctx && this.ctx.state !== 'closed') { try { await this.ctx.close(); } catch (e) {} }
    this.ctx = this.source = this.node = this.monitorGain = null;
  }
}
