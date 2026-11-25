/**
 * AudioWorklet 프로세서 소스(문자열). Blob URL로 addModule 한다.
 * - 입력 샘플레이트가 16kHz가 아니면 선형 보간으로 16kHz로 바꾼다(브라우저가 AudioContext({sampleRate:16000})을 거부한 경우).
 * - 약 100ms(1600샘플) 단위로 모아 Float32Array를 MessageChannel 포트(워커 직결)로 보낸다.
 * - RMS 음량은 node.port(메인)로 보낸다.
 */
export const WORKLET_NAME = 'winds-pcm-chunker';

export const WORKLET_SOURCE = `
class WindsPcmChunker extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var po = (options && options.processorOptions) || {};
    this.chunk = po.chunkSamples || 1600;
    this.ratio = sampleRate / 16000; // 출력 1샘플당 입력 샘플 수
    this.buf = new Float32Array(this.chunk);
    this.n = 0;
    this.pos = 0;
    this.prev = 0;
    this.out = null;
    this.stopped = false;
    var self = this;
    this.port.onmessage = function (e) {
      if (e.data && e.data.port) self.out = e.data.port;
      else if (e.data && e.data.stop) self.stopped = true;
    };
  }
  push(v) {
    this.buf[this.n++] = v;
    if (this.n === this.chunk) {
      var s = 0;
      for (var i = 0; i < this.chunk; i++) s += this.buf[i] * this.buf[i];
      this.port.postMessage({ level: Math.sqrt(s / this.chunk) });
      var out = this.buf;
      this.buf = new Float32Array(this.chunk);
      this.n = 0;
      if (this.out) this.out.postMessage(out, [out.buffer]);
    }
  }
  process(inputs) {
    if (this.stopped) return false;
    var input = inputs[0];
    var ch = input && input[0];
    if (!ch) return true;
    var N = ch.length;
    if (this.ratio === 1) {
      for (var i = 0; i < N; i++) this.push(ch[i]);
      return true;
    }
    while (this.pos < N - 1) {
      var i0 = Math.floor(this.pos);
      var f = this.pos - i0;
      var a = i0 < 0 ? this.prev : ch[i0];
      var b = ch[i0 + 1];
      this.push(a + (b - a) * f);
      this.pos += this.ratio;
    }
    this.pos -= N;
    this.prev = ch[N - 1];
    return true;
  }
}
registerProcessor('winds-pcm-chunker', WindsPcmChunker);
`;
