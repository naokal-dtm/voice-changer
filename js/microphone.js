// マイク取得。音声は端末内のみで処理し、外部へは送信しない。
export class Microphone {
  constructor() { this.stream = null; this.onEnded = null; }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('このブラウザはマイク入力に対応していないか、HTTPSで開かれていません。');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,   // 声を加工するので OFF
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      },
      video: false
    });
    const track = this.stream.getAudioTracks()[0];
    if (track) track.addEventListener('ended', () => this.onEnded && this.onEnded());
    return this.stream;
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
  }
}
