// Microphone, file decoding, preview encoding and playback.

import { aWeightDb, pickPeaks, toMono } from './dsp.js?v=4';

export const PREVIEW_SR = 24000;
const FADE_SEC = 0.005;

// Collects microphone samples in blocks of 4096 so the main thread gets few messages.
const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(4096); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('tap', Tap);
`;

export class Mic {
  ctx = null;
  recording = false;
  chunks = [];

  get on() {
    return this.ctx != null;
  }

  async start() {
    if (this.ctx != null) return;
    // Phones clean up the microphone for calls by default; that changes the sound.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const ctx = new AudioContext();
    await ctx.resume();
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = new AnalyserNode(ctx, { fftSize: 16384, smoothingTimeConstant: 0.3 });
    const tap = new AudioWorkletNode(ctx, 'tap');
    const mute = new GainNode(ctx, { gain: 0 });
    source.connect(analyser).connect(mute);
    source.connect(tap).connect(mute);
    mute.connect(ctx.destination);
    tap.port.onmessage = (e) => {
      if (this.recording) this.chunks.push(e.data);
    };
    const binHz = ctx.sampleRate / analyser.fftSize;
    this.weights = Float32Array.from({ length: analyser.frequencyBinCount }, (_, k) => aWeightDb(k * binHz));
    this.freq = new Float32Array(analyser.frequencyBinCount);
    this.time = new Float32Array(analyser.fftSize);
    Object.assign(this, { ctx, stream, analyser, binHz });
  }

  // Current input level (dBFS) and the strongest A-weighted peaks.
  read() {
    this.analyser.getFloatTimeDomainData(this.time);
    let sum = 0;
    for (const v of this.time) sum += v * v;
    this.analyser.getFloatFrequencyData(this.freq);
    const db = this.freq.map((v, k) => Math.max(v, -200) + this.weights[k]);
    return { levelDb: 10 * Math.log10(sum / this.time.length + 1e-20), peaks: pickPeaks(db, this.binHz) };
  }

  startRecording() {
    this.chunks = [];
    this.recording = true;
  }

  stopRecording() {
    this.recording = false;
    const samples = new Float32Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of this.chunks) {
      samples.set(c, offset);
      offset += c.length;
    }
    this.chunks = [];
    return { samples, sr: this.ctx.sampleRate };
  }

  async stop() {
    if (this.ctx == null) return;
    this.recording = false;
    for (const track of this.stream.getTracks()) track.stop();
    await this.ctx.close();
    this.ctx = null;
  }
}

export async function decodeFile(file) {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  return { samples: toMono(buffer), sr: buffer.sampleRate };
}

function encodeWav(samples, sr) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset, s) => [...s].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true));
  return bytes;
}

// Short listening copy: mono, 16-bit, 24 kHz, with 5 ms fades.
export async function makePreview(seg, sr) {
  const x = Float32Array.from(seg);
  const fade = Math.min(Math.round(FADE_SEC * sr), x.length >> 1);
  for (let i = 0; i < fade; i++) {
    x[i] *= i / fade;
    x[x.length - 1 - i] *= i / fade;
  }
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil((x.length * PREVIEW_SR) / sr)), PREVIEW_SR);
  const buffer = offline.createBuffer(1, x.length, sr);
  buffer.copyToChannel(x, 0);
  const node = new AudioBufferSourceNode(offline, { buffer });
  node.connect(offline.destination);
  node.start();
  const rendered = await offline.startRendering();
  return encodeWav(rendered.getChannelData(0), PREVIEW_SR);
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One sound at a time, whether it comes from raw samples or a URL.
let playCtx = null;
let current = null;

export function stopPlayback() {
  current?.stop();
  current = null;
}

export function playSamples(seg, sr, onEnd) {
  stopPlayback();
  playCtx ??= new AudioContext();
  const buffer = playCtx.createBuffer(1, seg.length, sr);
  buffer.copyToChannel(Float32Array.from(seg), 0);
  const node = new AudioBufferSourceNode(playCtx, { buffer });
  node.connect(playCtx.destination);
  const handle = { stop: () => node.stop() };
  node.onended = () => {
    if (current === handle) current = null;
    onEnd?.();
  };
  node.start();
  current = handle;
}

export function playUrl(url, onEnd) {
  stopPlayback();
  const audio = new Audio(url);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (current === handle) current = null;
    onEnd?.();
  };
  const handle = {
    stop: () => {
      audio.pause();
      finish();
    },
  };
  audio.onended = finish;
  audio.onerror = finish;
  current = handle;
  audio.play().catch(finish);
}
