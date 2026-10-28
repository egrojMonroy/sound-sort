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
  return {
    candidates: pickPeaks(weighted, binHz).map((p) => ({ hz: p.hz, prominenceDb: p.db - median })),
    centroidHz: den > 0 ? num / den : null,
    peak,
  };
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
