// Signal processing: splitting a recording into sounds and finding their pitch.

const FRAME = 2048;
const HOP = 512;
const MAX_ANALYSIS = 1 << 17; // ~2.7 s at 48 kHz; longer sounds are analysed from their start
const MAX_FFT = 1 << 18;
const MIN_FFT = 8192;
export const PITCH_MIN_HZ = 50;
export const PITCH_MAX_HZ = 12000;

export function toMono(buffer) {
  const out = new Float32Array(buffer.length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / channels;
  }
  return out;
}

// Frame RMS in dB below the loudest frame (centred frames, like librosa).
function frameDb(x) {
  const count = 1 + Math.floor(x.length / HOP);
  const rms = new Float64Array(count);
  let max = 1e-10;
  for (let f = 0; f < count; f++) {
    const centre = f * HOP;
    const a = Math.max(0, centre - FRAME / 2);
    const b = Math.min(x.length, centre + FRAME / 2);
    let sum = 0;
    for (let i = a; i < b; i++) sum += x[i] * x[i];
    rms[f] = Math.sqrt(sum / FRAME);
    if (rms[f] > max) max = rms[f];
  }
  return rms.map((r) => 20 * Math.log10(Math.max(r, 1e-10) / max));
}

// Regions [start, end) in samples where the sound is within topDb of the loudest frame.
export function findSounds(x, sr, { topDb, minGapMs, minLenMs, padStartMs, padEndMs }) {
  const db = frameDb(x);
  const raw = [];
  let start = -1;
  for (let f = 0; f <= db.length; f++) {
    const loud = f < db.length && db[f] > -topDb;
    if (loud && start < 0) start = f;
    if (!loud && start >= 0) {
      raw.push([start * HOP, Math.min(x.length, f * HOP)]);
      start = -1;
    }
  }
  const ms = (v) => Math.round((v / 1000) * sr);
  const merged = [];
  for (const [a, b] of raw) {
    const last = merged[merged.length - 1];
    if (last != null && a - last[1] < ms(minGapMs)) last[1] = b;
    else merged.push([a, b]);
  }
  const kept = merged.filter(([a, b]) => b - a >= ms(minLenMs));
  // Padding never reaches into a neighbour.
  return kept.map(([a, b], i) => {
    const prevEnd = i > 0 ? kept[i - 1][1] : 0;
    const nextStart = i + 1 < kept.length ? kept[i + 1][0] : x.length;
    return [Math.max(a - ms(padStartMs), prevEnd), Math.min(b + ms(padEndMs), nextStart)];
  });
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride];
        const wi = sin[k * stride];
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// A-weighting in dB: how loud each frequency sounds to a human ear.
// It keeps low thumps from winning over the note you actually hear.
export function aWeightDb(hz) {
  const f2 = hz * hz;
  const ra = (12194 ** 2 * f2 * f2) /
    ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(Math.max(ra, 1e-12)) + 2.0;
}

// Strongest local maxima of a dB spectrum, at least one semitone apart.
export function pickPeaks(db, binHz, count = 3) {
  const lo = Math.max(1, Math.ceil(PITCH_MIN_HZ / binHz));
  const hi = Math.min(db.length - 2, Math.floor(PITCH_MAX_HZ / binHz));
  const maxima = [];
  for (let k = lo; k <= hi; k++) {
    if (db[k] > db[k - 1] && db[k] >= db[k + 1]) maxima.push(k);
  }
  maxima.sort((a, b) => db[b] - db[a]);
  const peaks = [];
  for (const k of maxima) {
    const [a, b, c] = [db[k - 1], db[k], db[k + 1]];
    const curve = a - 2 * b + c;
    const offset = curve === 0 ? 0 : (0.5 * (a - c)) / curve;
    const hz = (k + offset) * binHz;
    if (peaks.some((p) => Math.abs(12 * Math.log2(hz / p.hz)) < 1)) continue;
    peaks.push({ hz, db: b - 0.25 * (a - c) * offset });
    if (peaks.length === count) break;
  }
  return peaks;
}

// ------------------------------------------------------------------ fundamental (YIN)

const YIN_RATE = 16000;
const LOW_BAND_RATE = 2400;
const LOW_BAND_MAX_HZ = 500;
const YIN_HOP_SEC = 0.016;
const YIN_THRESHOLD = 0.15;
export const F0_MIN_HZ = 50;
export const F0_MAX_HZ = 2000;

// Low-pass and keep every n-th sample, so the period search runs near 16 kHz.
function decimate(x, sr, rate = YIN_RATE) {
  const factor = Math.max(1, Math.floor(sr / rate));
  if (factor === 1) return { y: x, rate: sr };
  const taps = 47;
  const cutoff = 0.45 / factor;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - (taps - 1) / 2;
    const sinc = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1)));
    sum += h[i];
  }
  const y = new Float32Array(Math.floor(x.length / factor));
  for (let j = 0; j < y.length; j++) {
    const centre = j * factor;
    let acc = 0;
    for (let i = 0; i < taps; i++) {
      const k = centre + i - (taps - 1) / 2;
      if (k >= 0 && k < x.length) acc += x[k] * h[i];
    }
    y[j] = acc / sum;
  }
  return { y, rate: sr / factor };
}

// Frame-by-frame fundamental with YIN (de Cheveigné & Kawahara, 2002).
// Each frame gives f0 (Hz) and aperiodicity (0 = perfectly periodic, 1 = noise).
export function yinTrack(x, sr, { lowBand = false } = {}) {
  // The low band (below ~1 kHz) hears a low voice through breath noise.
  const { y, rate } = decimate(x, sr, lowBand ? LOW_BAND_RATE : YIN_RATE);
  const tauMin = Math.max(2, Math.floor(rate / (lowBand ? LOW_BAND_MAX_HZ : F0_MAX_HZ)));
  const tauMax = Math.ceil(rate / F0_MIN_HZ);
  const frames = [];
  const d = new Float64Array(tauMax + 2);
  const cmnd = new Float64Array(tauMax + 2);
  const window = tauMax + 1; // at least one period of the lowest note
  const hop = Math.max(1, Math.round(YIN_HOP_SEC * rate));
  for (let t = 0; t + window + tauMax + 1 <= y.length; t += hop) {
    let energy = 0;
    for (let j = 0; j < window; j++) energy += y[t + j] * y[t + j];
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let acc = 0;
      for (let j = 0; j < window; j++) {
        const diff = y[t + j] - y[t + j + tau];
        acc += diff * diff;
      }
      d[tau] = acc;
    }
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau];
      cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < YIN_THRESHOLD) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      best = tauMin;
      for (let tau = tauMin; tau <= tauMax; tau++) if (cmnd[tau] < cmnd[best]) best = tau;
    }
    const [a, b, c] = [cmnd[best - 1], cmnd[best], cmnd[best + 1]];
    const curve = a - 2 * b + c;
    const offset = best > tauMin && best < tauMax && curve > 0 ? (0.5 * (a - c)) / curve : 0;
    frames.push({
      time: (t + window / 2) / rate,
      f0: rate / (best + offset),
      aperiodicity: Math.min(1, b),
      rms: Math.sqrt(energy / window),
    });
  }
  return frames;
}

// The fundamental of the loud part of a sound, and how much of it repeats regularly.
// Tries the full band first, then the low band; keeps whichever repeats more regularly.
export function findFundamental(x, sr) {
  const full = yinTrack(x, sr);
  const fullSummary = summariseTrack(full);
  if (fullSummary.periodicity >= 0.5) return { ...fullSummary, track: full };
  const low = yinTrack(x, sr, { lowBand: true });
  const lowSummary = summariseTrack(low);
  return lowSummary.periodicity > fullSummary.periodicity
    ? { ...lowSummary, track: low }
    : { ...fullSummary, track: full };
}

export function summariseTrack(frames) {
  const loudest = frames.reduce((m, f) => Math.max(m, f.rms), 0);
  const loud = frames.filter((f) => f.rms > loudest * 10 ** (-25 / 20));
  const voiced = loud.filter((f) => f.aperiodicity < 0.25);
  if (loud.length === 0 || voiced.length === 0) return { f0Hz: null, periodicity: 0 };
  const sorted = voiced.map((f) => f.f0).sort((p, q) => p - q);
  return { f0Hz: sorted[sorted.length >> 1], periodicity: voiced.length / loud.length };
}

// How clearly a spectrum (dB per bin) shows a harmonic series on f0:
// the average height of the peaks at f0, 2·f0, 3·f0… above the floor around each one.
const HARMONIC_TOP_HZ = 5000;
const HARMONIC_COUNT = 10;

export function harmonicSupport(db, binHz, f0) {
  let total = 0;
  let count = 0;
  for (let k = 1; k <= HARMONIC_COUNT && k * f0 <= HARMONIC_TOP_HZ; k++) {
    const centre = k * f0;
    const peakLo = Math.floor((centre * 0.97) / binHz);
    const peakHi = Math.ceil((centre * 1.03) / binHz);
    const floorLo = Math.max(1, Math.floor((centre - 0.5 * f0) / binHz));
    const floorHi = Math.min(db.length - 1, Math.ceil((centre + 0.5 * f0) / binHz));
    if (peakHi >= db.length) break;
    let peak = -Infinity;
    for (let i = peakLo; i <= peakHi; i++) peak = Math.max(peak, db[i]);
    const around = Array.from(db.subarray(floorLo, floorHi + 1)).sort((a, b) => a - b);
    const floor = around[around.length >> 1];
    total += Math.max(0, Math.min(30, peak - floor));
    count++;
  }
  return count >= 3 ? total / count : 0;
}

// Octave check: noisy low notes can be read an octave (or two) too low.
// If f0·2 explains the spectrum better than f0, the note is an octave higher.
export function correctOctave(db, binHz, f0) {
  let best = f0;
  let bestScore = harmonicSupport(db, binHz, f0);
  for (const factor of [2, 4]) {
    const score = harmonicSupport(db, binHz, f0 * factor);
    if (f0 * factor <= F0_MAX_HZ && score > bestScore + 2) {
      best = f0 * factor;
      bestScore = score;
    }
  }
  return { f0Hz: best, support: bestScore };
}

function nextPow2(n) {
  return 2 ** Math.ceil(Math.log2(Math.max(n, 1)));
}

// Pitch candidates (strongest first), brightness and peak level of one sound.
export function analyse(seg, sr) {
  const len = Math.min(seg.length, MAX_ANALYSIS);
  const n = Math.min(MAX_FFT, Math.max(MIN_FFT, nextPow2(len * 4)));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    re[i] = seg[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(len - 1, 1)));
    peak = Math.max(peak, Math.abs(seg[i]));
  }
  fft(re, im);
  const binHz = sr / n;
  const weighted = new Float64Array(n / 2);
  let num = 0;
  let den = 0;
  for (let k = 0; k < n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    num += k * binHz * mag;
    den += mag;
    weighted[k] = 20 * Math.log10(mag + 1e-12) + aWeightDb(k * binHz);
  }
  const lo = Math.ceil(PITCH_MIN_HZ / binHz);
  const hi = Math.min(n / 2, Math.floor(PITCH_MAX_HZ / binHz));
  const band = weighted.slice(lo, hi).sort();
  const median = band[band.length >> 1] ?? 0;
  const raw = new Float32Array(n / 2);
  for (let k = 0; k < n / 2; k++) raw[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-12);
  const { f0Hz: yinF0, periodicity } = findFundamental(seg, sr);
  const fundamental = yinF0 != null ? correctOctave(raw, binHz, yinF0) : { f0Hz: null, support: 0 };
  // Spectral median: half the energy lies below it (CDP's "brightness").
  let half = 0;
  for (let k = lo; k < n / 2; k++) half += Math.hypot(re[k], im[k]);
  half /= 2;
  let medianHz = null;
  for (let k = lo, acc = 0; k < n / 2; k++) {
    acc += Math.hypot(re[k], im[k]);
    if (acc >= half) {
      medianHz = k * binHz;
      break;
    }
  }
  const peaks = pickPeaks(weighted, binHz).map((p) => ({ hz: p.hz, prominenceDb: p.db - median, source: 'peak' }));
  const kind = classify(fundamental.f0Hz, periodicity, fundamental.support, peaks[0]?.prominenceDb ?? 0);
  const candidates = [
    ...(fundamental.f0Hz != null && kind === 'note' ? [{ hz: fundamental.f0Hz, prominenceDb: fundamental.support, source: 'fundamental' }] : []),
    ...peaks.filter((p) => kind !== 'note' || Math.abs(12 * Math.log2(p.hz / fundamental.f0Hz)) >= 0.5),
    ...(medianHz != null ? [{ hz: medianHz, prominenceDb: 0, source: 'brightness' }] : []),
  ];
  const register = { note: candidates[0], node: peaks[0], noise: candidates[candidates.length - 1] }[kind];
  return {
    candidates,
    defaultHz: register?.hz ?? null,
    kind,
    centroidHz: den > 0 ? num / den : null,
    medianHz,
    f0Hz: fundamental.f0Hz,
    periodicity,
    harmonicDb: fundamental.support,
    peak,
  };
}

// Smalley's note / node / noise, measured:
// note  = a fundamental with a clear harmonic series (voice, strings, most instruments, ringing objects);
// node  = no harmonic series, but one frequency clearly stands out (bells, metal, glass);
// noise = neither; its register is the spectral median.
const NOTE_HARMONIC_DB = 12;
const NOTE_PERIODICITY = 0.2;
const NODE_PROMINENCE_DB = 25;

function classify(f0Hz, periodicity, harmonicDb, topProminenceDb) {
  if (f0Hz != null && harmonicDb >= NOTE_HARMONIC_DB && periodicity >= NOTE_PERIODICITY) return 'note';
  if (topProminenceDb >= NODE_PROMINENCE_DB) return 'node';
  return 'noise';
}

// Short-time spectrum for drawing: dB frames, at most maxFrames of them.
export function spectrogram(x, sr, maxFrames = 300) {
  const size = 2048;
  const hop = Math.max(128, Math.ceil(Math.max(1, x.length - size) / maxFrames));
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const frames = [];
  for (let t = 0; t === 0 || t + size <= x.length; t += hop) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size && t + i < x.length; i++) re[i] = x[t + i] * window[i];
    fft(re, im);
    const db = new Float32Array(size / 2);
    for (let k = 0; k < size / 2; k++) db[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-9);
    frames.push(db);
    if (t + size >= x.length) break;
  }
  return { frames, binHz: sr / size, hopSec: hop / sr };
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export function noteOf(hz) {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const nearest = Math.round(midi);
  return {
    name: NOTE_NAMES[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1),
    cents: Math.round((midi - nearest) * 100),
  };
}

export function formatNote(hz) {
  if (hz == null) return '—';
  const { name, cents } = noteOf(hz);
  return `${name} ${cents >= 0 ? '+' : '−'}${Math.abs(cents)}¢`;
}
