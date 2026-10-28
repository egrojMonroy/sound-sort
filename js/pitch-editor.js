// Choose the frequency a sound is sorted by: spectrogram you can tap, Hz field,
// slider, octave buttons, and a reference tone to compare by ear.

import { formatNote, spectrogram, yinTrack } from './dsp.js?v=7';
import { playSamples, stopPlayback } from './audio.js?v=7';

const LOW_HZ = 40;
const HIGH_HZ = 10000;
const SLIDER_STEPS = 1000;

export const KINDS = {
  note: { label: 'Note', hint: 'A clear fundamental. Sorted by its pitch.' },
  node: { label: 'Node', hint: 'No clear fundamental, one strong frequency. Sorted by that frequency.' },
  noise: { label: 'Noise', hint: 'No pitch. Sorted by brightness (where half the energy lies).' },
};

const SOURCE_LABELS = { fundamental: 'fundamental', peak: 'strong peak', brightness: 'brightness' };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

const clampHz = (hz) => Math.max(LOW_HZ, Math.min(HIGH_HZ, hz));
const toSlider = (hz) => Math.round((Math.log(clampHz(hz) / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ)) * SLIDER_STEPS);
const fromSlider = (v) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (v / SLIDER_STEPS);

function hexToRgb(color) {
  const hex = color.trim().replace('#', '');
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0);
}

// value: { pitchHz, confirmed, kind }; candidates: [{ hz, source }]; defaults: kind -> Hz.
export function pitchEditor({ loadAudio, candidates, defaults, value, onChange }) {
  const state = { ...value };
  let audio = null;
  let image = null;
  let track = [];

  const canvas = el('canvas', { className: 'spectro', 'aria-label': 'Spectrogram. Tap a line to choose its frequency.' });
  const noteText = el('b', { className: 'pe-note' });
  const hzInput = el('input', { type: 'number', min: String(LOW_HZ), max: String(HIGH_HZ), step: '0.1', className: 'pe-hz', 'aria-label': 'Frequency in Hz' });
  const slider = el('input', { type: 'range', min: '0', max: String(SLIDER_STEPS), step: '1', 'aria-label': 'Frequency' });
  const sure = el('span', { className: 'pe-sure' });
  const kindButtons = Object.entries(KINDS).map(([kind, info]) => el('button', {
    type: 'button',
    className: 'chip',
    textContent: info.label,
    title: info.hint,
    onclick: () => {
      state.kind = kind;
      state.pitchHz = defaults[kind] ?? state.pitchHz;
      state.confirmed = false;
      update(true);
    },
  }));
  const kindHint = el('p', { className: 'hint pe-kind-hint' });
  const chipBox = el('div', { className: 'chips' });
  const status = el('p', { className: 'muted pe-status', textContent: 'Loading the spectrogram…' });

  function setHz(hz, commit) {
    state.pitchHz = clampHz(hz);
    state.confirmed = true;
    update(commit);
  }

  function update(commit) {
    const hz = state.pitchHz;
    noteText.textContent = hz == null ? '—' : `${state.kind === 'noise' ? '≈ ' : ''}${formatNote(hz)}`;
    if (document.activeElement !== hzInput) hzInput.value = hz == null ? '' : hz.toFixed(1);
    slider.value = String(hz == null ? 0 : toSlider(hz));
    sure.textContent = state.confirmed ? '✓ chosen by ear' : '? not confirmed yet';
    sure.classList.toggle('q', !state.confirmed);
    for (const [i, kind] of Object.keys(KINDS).entries()) kindButtons[i].classList.toggle('on', state.kind === kind);
    kindHint.textContent = KINDS[state.kind]?.hint ?? '';
    chipBox.replaceChildren(...candidates.map((c) => el('button', {
      type: 'button',
      className: `chip${hz != null && Math.abs(c.hz - hz) < 0.05 ? ' on' : ''}`,
      onclick: () => setHz(c.hz, true),
    }, `${formatNote(c.hz)} · ${Math.round(c.hz)} Hz `, el('small', { textContent: SOURCE_LABELS[c.source] ?? '' }))));
    draw();
    if (commit) onChange({ ...state });
  }

  const yOf = (hz, height) => height * (1 - Math.log(hz / LOW_HZ) / Math.log(HIGH_HZ / LOW_HZ));
  const hzOf = (y, height) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (1 - y / height);

  // Renders the spectrogram once into an offscreen image; overlays are redrawn on every change.
  function renderImage(width, height) {
    const spec = spectrogram(audio.samples, audio.sr);
    const css = getComputedStyle(document.documentElement);
    const bg = hexToRgb(css.getPropertyValue('--bg'));
    const fg = hexToRgb(css.getPropertyValue('--text'));
    let max = -Infinity;
    for (const f of spec.frames) for (const v of f) if (v > max) max = v;
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const g = offscreen.getContext('2d');
    const pixels = g.createImageData(width, height);
    const bins = new Int32Array(height);
    for (let y = 0; y < height; y++) bins[y] = Math.min(spec.frames[0].length - 1, Math.round(hzOf(y + 0.5, height) / spec.binHz));
    for (let x = 0; x < width; x++) {
      const frame = spec.frames[Math.min(spec.frames.length - 1, Math.floor((x / width) * spec.frames.length))];
      for (let y = 0; y < height; y++) {
        const v = Math.max(0, Math.min(1, (frame[bins[y]] - (max - 70)) / 70)) ** 1.6;
        const o = (y * width + x) * 4;
        for (let c = 0; c < 3; c++) pixels.data[o + c] = bg[c] + (fg[c] - bg[c]) * v;
        pixels.data[o + 3] = 255;
      }
    }
    g.putImageData(pixels, 0, 0);
    return { canvas: offscreen, duration: audio.samples.length / audio.sr };
  }

  function draw() {
    if (audio == null || canvas.clientWidth === 0) return;
    const ratio = window.devicePixelRatio ?? 1;
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height || image == null) {
      canvas.width = width;
      canvas.height = height;
      image = renderImage(width, height);
    }
    const g = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    g.drawImage(image.canvas, 0, 0);
    g.font = `${11 * ratio}px system-ui, sans-serif`;
    g.fillStyle = css.getPropertyValue('--text-2');
    for (const hz of [50, 100, 200, 500, 1000, 2000, 5000]) {
      const y = yOf(hz, height);
      const label = hz >= 1000 ? `${hz / 1000}k` : String(hz);
      g.globalAlpha = 0.85;
      g.fillStyle = css.getPropertyValue('--surface');
      g.fillRect(0, y - 7 * ratio, g.measureText(label).width + 12 * ratio, 14 * ratio);
      g.globalAlpha = 1;
      g.fillStyle = css.getPropertyValue('--text-2');
      g.fillRect(0, y, 4 * ratio, ratio);
      g.fillText(label, 6 * ratio, y + 4 * ratio);
    }
    // The fundamental found frame by frame, where the sound repeats regularly.
    g.fillStyle = css.getPropertyValue('--warn');
    for (const f of track) {
      if (f.aperiodicity >= 0.25) continue;
      g.beginPath();
      g.arc((f.time / image.duration) * width, yOf(f.f0, height), 2.2 * ratio, 0, 2 * Math.PI);
      g.fill();
    }
    if (state.pitchHz != null) {
      const y = yOf(state.pitchHz, height);
      g.fillStyle = css.getPropertyValue('--accent');
      g.fillRect(0, y - ratio, width, 2 * ratio);
      const label = `${formatNote(state.pitchHz)} · ${state.pitchHz.toFixed(1)} Hz`;
      const w = g.measureText(label).width + 10 * ratio;
      const top = Math.max(0, Math.min(height - 18 * ratio, y - 20 * ratio));
      g.fillRect(width - w, top, w, 18 * ratio);
      g.fillStyle = css.getPropertyValue('--accent-text');
      g.fillText(label, width - w + 5 * ratio, top + 13 * ratio);
    }
  }

  let dragging = false;
  const pick = (e) => {
    const box = canvas.getBoundingClientRect();
    setHz(hzOf(e.clientY - box.top, box.height), false);
  };
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    pick(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) pick(e);
  });
  const release = () => {
    if (!dragging) return;
    dragging = false;
    onChange({ ...state });
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  hzInput.addEventListener('change', () => {
    const hz = Number(hzInput.value);
    if (hz > 0) setHz(hz, true);
  });
  slider.addEventListener('input', () => setHz(fromSlider(Number(slider.value)), false));
  slider.addEventListener('change', () => onChange({ ...state }));

  const play = (options) => () => {
    if (audio == null) return;
    playSamples(audio.samples, audio.sr, null, options());
  };
  const node = el('div', { className: 'details pitch-editor' },
    el('div', { className: 'chips pe-kinds' }, el('span', { className: 'muted', textContent: 'Type' }), ...kindButtons),
    kindHint,
    canvas,
    status,
    el('div', { className: 'row wrap pe-controls' },
      noteText,
      el('label', { className: 'pe-hz-label' }, hzInput, ' Hz'),
      el('button', { type: 'button', textContent: '÷2', title: 'One octave lower', onclick: () => setHz(state.pitchHz / 2, true) }),
      el('button', { type: 'button', textContent: '×2', title: 'One octave higher', onclick: () => setHz(state.pitchHz * 2, true) }),
      sure),
    slider,
    el('div', { className: 'row wrap' },
      el('button', { type: 'button', textContent: '▶ Sound', onclick: play(() => ({})) }),
      el('button', { type: 'button', textContent: '▶ Tone', onclick: play(() => ({ sound: false, toneHz: state.pitchHz })) }),
      el('button', { type: 'button', textContent: '▶ Together', onclick: play(() => ({ toneHz: state.pitchHz })) }),
      el('button', {
        type: 'button',
        className: 'primary',
        textContent: '✓ That is what I hear',
        onclick: () => {
          state.confirmed = true;
          update(true);
        },
      })),
    el('p', { className: 'hint', textContent: 'Tap or drag on the spectrogram to choose a frequency. Orange dots are the fundamental, where the sound repeats regularly. Play the tone together with the sound: when they match, they stop beating.' }),
    chipBox,
  );
  node.stop = stopPlayback;

  update(false);
  loadAudio()
    .then((loaded) => {
      audio = loaded;
      track = yinTrack(audio.samples, audio.sr);
      status.remove();
      requestAnimationFrame(draw);
    })
    .catch((e) => {
      status.textContent = `Couldn't load the sound: ${e.message}`;
    });
  window.addEventListener('resize', () => {
    image = null;
    draw();
  });
  return node;
}
