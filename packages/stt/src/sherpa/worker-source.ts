/**
 * sherpa-onnx 클래식 Web Worker 소스(문자열). Blob URL로 띄우고 importScripts로 벤더 glue를 읽는다.
 * 번들러 설정에 기대지 않으려고 문자열로 둔다. 문자열 안에서는 백틱과 달러 중괄호를 쓰지 않는다.
 *
 * main -> worker: init | audio-port | start | stop | transcribe | dispose
 * worker -> main: progress | log | ready | partial | final | metrics | stopped | transcribed | error
 */
export const WORKER_SOURCE = String.raw`
'use strict';
var Module = null, recognizer = null, stream = null, live = false;
var lastText = '', lastChangeAt = 0, segStart = 0, audioPort = null;
var SR = 16000;

function post(m, t) { self.postMessage(m, t || []); }
function log(s) { post({ type: 'log', message: s }); }
function errMsg(e) { return (e && e.message) ? e.message : String(e); }

async function fetchBytes(url, onProgress) {
  var res = await fetch(url);
  if (!res.ok) throw new Error('fetch ' + url + ' -> HTTP ' + res.status);
  var total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) { var ab = await res.arrayBuffer(); onProgress(ab.byteLength, ab.byteLength); return ab; }
  var reader = res.body.getReader(), chunks = [], n = 0;
  for (;;) {
    var r = await reader.read();
    if (r.done) break;
    chunks.push(r.value); n += r.value.length;
    onProgress(n, total || n);
  }
  var out = new Uint8Array(n), o = 0;
  for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
  return out.buffer;
}

async function init(d) {
  var t0 = performance.now();
  importScripts(d.wasmBase + 'sherpa-onnx-wasm-web.js', d.wasmBase + 'sherpa-onnx-asr.js');
  log('glue loaded (SherpaOnnx=' + typeof SherpaOnnx + ', createOnlineRecognizer=' + typeof createOnlineRecognizer + ')');
  var wasmBinary = await fetchBytes(d.wasmBase + 'sherpa-onnx-wasm-web.wasm', function (l, t) {
    post({ type: 'progress', phase: 'wasm', file: 'sherpa-onnx-wasm-web.wasm', loaded: l, total: t });
  });
  Module = await SherpaOnnx({
    wasmBinary: wasmBinary,
    print: function () {},
    printErr: function (s) { if (d.verbose) log('wasm: ' + s); }
  });
  log('wasm-initialized (' + Math.round(performance.now() - t0) + 'ms, FS=' + typeof Module.FS + ', HEAPF32=' + typeof Module.HEAPF32 + ')');

  try { Module.FS.mkdir('/m'); } catch (e) { /* exists */ }
  var paths = {};
  for (var i = 0; i < d.files.length; i++) {
    var f = d.files[i];
    var p = '/m/' + f.role + (f.role === 'tokens' ? '.txt' : '.onnx');
    Module.FS.writeFile(p, new Uint8Array(f.data));
    paths[f.role] = p;
    f.data = null;
  }
  log('model-written (' + d.files.length + ' files)');

  var hot = d.hotwords || '';
  var cfg = {
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
      tokens: paths.tokens,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: d.modelType || '',
      modelingUnit: d.modelingUnit || 'cjkchar',
      bpeVocab: ''
    },
    decodingMethod: d.decodingMethod || (hot ? 'modified_beam_search' : 'greedy_search'),
    maxActivePaths: 4,
    enableEndpoint: 1,
    rule1MinTrailingSilence: d.rule1,
    rule2MinTrailingSilence: d.rule2,
    rule3MinUtteranceLength: d.rule3,
    hotwordsFile: '',
    hotwordsBuf: hot,
    hotwordsBufSize: hot ? Module.lengthBytesUTF8(hot) : 0,
    hotwordsScore: d.hotwordsScore || 1.5,
    blankPenalty: 0,
    ruleFsts: '',
    ruleFars: ''
  };
  recognizer = createOnlineRecognizer(Module, cfg);
  log('recognizer-created (decoding=' + cfg.decodingMethod + ')');

  // 워밍업: 무음 0.3초를 흘려 파이프라인이 실제로 도는지 확인한다
  var step = 'createStream';
  try {
    var ws = recognizer.createStream();
    step = 'acceptWaveform'; ws.acceptWaveform(SR, new Float32Array(SR * 0.3));
    step = 'isReady/decode';
    while (recognizer.isReady(ws)) { step = 'decode'; recognizer.decode(ws); step = 'isReady'; }
    step = 'getResult'; recognizer.getResult(ws);
    step = 'free'; ws.free();
  } catch (e) {
    throw new Error('warmup 실패 (' + step + '): ' + errMsg(e) + (e && e.stack ? ' | ' + String(e.stack).split('\n').slice(0, 6).join(' / ') : ''));
  }
  log('warmup-ok');

  if (d.freeModelFiles !== false) {
    // 세션이 이미 메모리에 올렸으므로 MEMFS 사본은 지워 메모리를 줄인다
    for (var role in paths) { try { Module.FS.unlink(paths[role]); } catch (e) { /* ignore */ } }
    log('model-files-unlinked');
  }
  stream = recognizer.createStream();
  post({ type: 'ready', initMs: Math.round(performance.now() - t0), heapBytes: Module.HEAPF32 ? Module.HEAPF32.buffer.byteLength : 0 });
}

function resetSegment() { lastText = ''; lastChangeAt = 0; segStart = 0; }

function emitFinal(text) {
  if (text) post({ type: 'final', text: text, startedAt: segStart || undefined, endedAt: lastChangeAt || Date.now() });
}

function onAudio(f32) {
  if (!live || !stream) return;
  var t0 = performance.now();
  stream.acceptWaveform(SR, f32);
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  var text = (recognizer.getResult(stream).text || '').trim();
  var now = Date.now();
  if (text !== lastText) {
    if (!lastText) segStart = now;
    lastText = text; lastChangeAt = now;
    if (text) post({ type: 'partial', text: text });
  }
  if (recognizer.isEndpoint(stream)) {
    emitFinal(text);
    recognizer.reset(stream);
    resetSegment();
  }
  post({ type: 'metrics', audioMs: f32.length * 1000 / SR, decodeMs: performance.now() - t0 });
}

function flushLive() {
  if (!stream) return;
  stream.inputFinished();
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  var text = (recognizer.getResult(stream).text || '').trim();
  if (text && text !== lastText) { lastText = text; lastChangeAt = Date.now(); }
  emitFinal(text);
  recognizer.reset(stream);
  resetSegment();
}

function transcribe(d) {
  var samples = d.samples, sr = d.sampleRate;
  var s = recognizer.createStream();
  var step = Math.max(1, Math.round(sr * 0.1));
  var segs = [], last = '', decodeMs = 0, done = 0;
  function pull(endSample) {
    var text = (recognizer.getResult(s).text || '').trim();
    if (recognizer.isEndpoint(s)) {
      if (text) segs.push({ text: text, endSec: endSample / sr });
      recognizer.reset(s); last = '';
    } else last = text;
  }
  for (var o = 0; o < samples.length; o += step) {
    var chunk = samples.subarray(o, Math.min(samples.length, o + step));
    var t0 = performance.now();
    s.acceptWaveform(sr, chunk);
    while (recognizer.isReady(s)) recognizer.decode(s);
    pull(o + chunk.length);
    decodeMs += performance.now() - t0;
    done = o + chunk.length;
    if (((o / step) | 0) % 50 === 0) post({ type: 'transcribe-progress', id: d.id, done: done / samples.length });
  }
  var t1 = performance.now();
  s.acceptWaveform(sr, new Float32Array(Math.round(sr * 0.8))); // 꼬리 무음
  s.inputFinished();
  while (recognizer.isReady(s)) recognizer.decode(s);
  var tail = (recognizer.getResult(s).text || '').trim();
  if (tail) segs.push({ text: tail, endSec: samples.length / sr });
  else if (last) segs.push({ text: last, endSec: samples.length / sr });
  decodeMs += performance.now() - t1;
  s.free();
  var audioMs = samples.length * 1000 / sr;
  post({
    type: 'transcribed', id: d.id,
    result: { text: segs.map(function (x) { return x.text; }).join(' ').trim(), segments: segs, audioMs: audioMs, decodeMs: decodeMs, rtf: audioMs ? decodeMs / audioMs : 0 }
  });
}

self.onmessage = async function (ev) {
  var d = ev.data;
  try {
    switch (d.type) {
      case 'init': await init(d); break;
      case 'audio-port':
        if (audioPort) audioPort.onmessage = null;
        audioPort = d.port;
        audioPort.onmessage = function (e) { try { onAudio(e.data); } catch (err) { post({ type: 'error', message: errMsg(err) }); } };
        break;
      case 'start': resetSegment(); if (stream) recognizer.reset(stream); live = true; break;
      case 'stop':
        live = false;
        if (audioPort) { audioPort.onmessage = null; }
        flushLive();
        post({ type: 'stopped', id: d.id });
        break;
      case 'transcribe': transcribe(d); break;
      case 'dispose':
        try { if (stream) stream.free(); if (recognizer) recognizer.free(); } catch (e) { /* ignore */ }
        post({ type: 'disposed' });
        self.close();
        break;
    }
  } catch (err) {
    post({ type: 'error', message: errMsg(err), phase: d.type, id: d.id });
  }
};
`;
