import { analyse, findSounds, formatNote } from './dsp.js?v=3';
import { Mic, decodeFile, makePreview, playSamples, playUrl, sha256Hex, stopPlayback } from './audio.js?v=3';
import { Repo } from './github.js?v=3';

const LIBRARY_PATH = 'library/sounds.json';
const SETTINGS_KEY = 'sound-sort.github';
const FORMAT = 'sound-sort/1';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

const round = (v, digits) => (v == null ? null : Number(v.toFixed(digits)));
const today = () => new Date().toISOString().slice(0, 10);

let toastTimer = null;
function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = message;
  node.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.className = ''), isError ? 6000 : 3000);
}

// ------------------------------------------------------------------ state

const emptyLibrary = () => ({ format: FORMAT, nextId: 1, sounds: [], sorts: [] });

const state = {
  library: emptyLibrary(), // as last loaded from or saved to GitHub
  pending: { added: [], edits: new Map(), deleted: new Set(), sorts: [] },
  wavs: new Map(), // pending sound id -> preview bytes
  previewUrls: new Map(), // sound id -> blob URL, for sounds the site hasn't published yet
  tempId: 0,
  openId: null,
  playingId: null,
};

const pendingCount = () =>
  state.pending.added.length + state.pending.edits.size + state.pending.deleted.size + state.pending.sorts.length;

// Applies unsaved changes to a library. With assignIds, new sounds get their permanent IDs.
function merge(base, pending, assignIds) {
  const doc = structuredClone(base);
  doc.sounds = doc.sounds
    .filter((s) => !pending.deleted.has(s.id))
    .map((s) => ({ ...s, ...(pending.edits.get(s.id) ?? {}) }));
  const idMap = new Map();
  for (const s of pending.added) {
    if (doc.sounds.some((o) => o.hash === s.hash)) continue; // already saved from elsewhere
    const id = assignIds ? `S${String(doc.nextId++).padStart(4, '0')}` : s.id;
    idMap.set(s.id, id);
    doc.sounds.push({ ...s, ...(pending.edits.get(s.id) ?? {}), id, preview: `library/previews/${id}.wav` });
  }
  const known = new Set(doc.sounds.map((s) => s.id));
  doc.sorts = [
    ...doc.sorts,
    ...pending.sorts.map((o) => ({ ...o, ids: o.ids.map((i) => idMap.get(i) ?? i).filter((i) => known.has(i)) })),
  ];
  return { doc, idMap };
}

const view = () => merge(state.library, state.pending, false).doc;

function editSound(id, fields) {
  state.pending.edits.set(id, { ...(state.pending.edits.get(id) ?? {}), ...fields });
  renderLibrary();
}

function deleteSound(id) {
  const added = state.pending.added.findIndex((s) => s.id === id);
  if (added >= 0) {
    state.pending.added.splice(added, 1);
    state.wavs.delete(id);
  } else {
    state.pending.deleted.add(id);
  }
  state.pending.edits.delete(id);
  renderLibrary();
}

// ------------------------------------------------------------------ settings

function defaultRepo() {
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    return { owner: host.split('.')[0], repo: location.pathname.split('/')[1] || host };
  }
  return { owner: 'egrojMonroy', repo: 'sound-sort' };
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    saved = {};
  }
  return { ...defaultRepo(), branch: 'main', token: '', ...saved };
}

function storeSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

let settings = loadSettings();
const repo = () => (settings.token !== '' ? new Repo(settings) : null);

// ------------------------------------------------------------------ loading

async function loadLibrary() {
  try {
    const gh = repo();
    // With a token, read straight from GitHub: the published site lags a minute behind each save.
    const text = gh != null
      ? await gh.readText(LIBRARY_PATH, settings.branch)
      : await fetch(LIBRARY_PATH, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : null));
    state.library = text != null ? JSON.parse(text) : emptyLibrary();
  } catch (e) {
    toast(`Couldn't load the library: ${e.message}`, true);
  }
  renderLibrary();
}

// ------------------------------------------------------------------ settings panel

function toggleSettings(open = $('settings').hidden) {
  $('settings').hidden = !open;
  $('btnSettings').setAttribute('aria-expanded', String(open));
  if (open) $('settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function status(message, isError = false) {
  const node = $('addStatus');
  node.textContent = message;
  node.classList.toggle('error', isError);
}

// ------------------------------------------------------------------ microphone

const mic = new Mic();
let listening = false;
let lastReading = 0;
let recordStart = 0;

async function ensureMic() {
  try {
    await mic.start();
    requestAnimationFrame(readoutLoop);
    return true;
  } catch (e) {
    status(`Microphone unavailable: ${e.message}`, true);
    return false;
  }
}

function readoutLoop() {
  if (!mic.on) {
    $('roLevel').style.width = '0';
    $('readout').classList.add('stale');
    return;
  }
  const { levelDb, peaks } = mic.read();
  $('roLevel').style.width = `${Math.max(0, Math.min(1, (levelDb + 70) / 70)) * 100}%`;
  const now = performance.now();
  if (levelDb > -55 && peaks.length > 0) {
    lastReading = now;
    $('roNote').textContent = formatNote(peaks[0].hz);
    $('roHz').textContent = `${peaks[0].hz.toFixed(1)} Hz`;
    $('roAlts').textContent = peaks.slice(1).map((p) => `${formatNote(p.hz)} (${Math.round(p.hz)} Hz)`).join('    ');
  }
  $('readout').classList.toggle('stale', now - lastReading > 1500);
  if (mic.recording) {
    const sec = (now - recordStart) / 1000;
    status(`Recording… ${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}. Tap Stop when you're done.`);
  }
  requestAnimationFrame(readoutLoop);
}

async function toggleListen() {
  if (listening) {
    listening = false;
    if (!mic.recording) await mic.stop();
  } else if (await ensureMic()) {
    listening = true;
  }
  $('btnListen').textContent = listening ? 'Stop listening' : 'Listen';
}

async function toggleRecord() {
  if (mic.recording) {
    const { samples, sr } = mic.stopRecording();
    if (!listening) await mic.stop();
    $('btnRecord').textContent = '● Record';
    if (samples.length < sr * 0.1) {
      status('The recording was too short.', true);
      return;
    }
    const stamp = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    await addTake(samples, sr, null, `Recording ${stamp}`);
    return;
  }
  if (!(await ensureMic())) return;
  mic.startRecording();
  recordStart = performance.now();
  $('btnRecord').textContent = '■ Stop';
}

async function onFiles(e) {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length === 0) {
    status('No file was selected. If the file picker did not open, try another browser.', true);
    return;
  }
  for (const [i, file] of files.entries()) {
    const which = files.length > 1 ? ` (${i + 1} of ${files.length})` : '';
    status(`Reading ${file.name}${which}…`);
    try {
      const { samples, sr } = await decodeFile(file);
      await addTake(samples, sr, file.name, file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      status(`This browser can't read ${file.name}: ${err.message}`, true);
      return;
    }
  }
}

// ------------------------------------------------------------------ review

// Each recording or file is one take. Its sounds wait here until you add them.
const takes = [];
let takeCount = 0;

function params() {
  return {
    topDb: Number($('topDb').value),
    minGapMs: Number($('minGap').value),
    minLenMs: 50,
    padStartMs: 5,
    padEndMs: Number($('tail').value),
  };
}

function showParams() {
  $('topDbOut').textContent = `${$('topDb').value} dB`;
  $('gapOut').textContent = `${$('minGap').value} ms`;
  $('tailOut').textContent = `${$('tail').value} ms`;
}

function updateReviewSummary() {
  const all = takes.flatMap((t) => t.slices);
  const kept = all.filter((s) => s.keep).length;
  $('review').hidden = takes.length === 0;
  $('btnAdd').textContent = `Add ${kept} sound${kept === 1 ? '' : 's'} to library`;
  $('btnAdd').disabled = kept === 0;
}

async function addTake(samples, sr, sourceFile, source) {
  const take = { id: ++takeCount, samples, sr, sourceFile, slices: [], cache: new Map(), generation: 0 };
  const nameInput = el('input', { value: source, autocomplete: 'off', 'aria-label': 'Source name' });
  nameInput.addEventListener('input', () => {
    for (const [i, input] of [...take.list.querySelectorAll('.name')].entries()) input.placeholder = defaultName(take, i);
  });
  take.nameInput = nameInput;
  take.canvas = el('canvas', { className: 'wave', 'aria-label': 'Waveform. Tap a sound to hear it.' });
  take.canvas.addEventListener('click', (e) => {
    const box = take.canvas.getBoundingClientRect();
    const at = ((e.clientX - box.left) / box.width) * take.samples.length;
    const index = take.slices.findIndex((s) => at >= s.start && at < s.end);
    if (index >= 0) playSlice(take, take.slices[index], take.list.children[index]);
  });
  take.info = el('p', { className: 'muted' });
  take.list = el('ol', { className: 'list' });
  take.node = el('div', { className: 'take' },
    el('div', { className: 'take-head' },
      el('label', { className: 'field' }, 'Source name', nameInput),
      el('button', { type: 'button', textContent: 'Remove', onclick: () => removeTake(take) })),
    take.canvas, take.info, take.list);
  takes.push(take);
  $('takes').append(take.node);
  updateReviewSummary();
  await analyseTake(take);
  if (takes.includes(take)) take.node.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function removeTake(take) {
  stopPlayback();
  take.generation++;
  takes.splice(takes.indexOf(take), 1);
  take.node.remove();
  updateReviewSummary();
}

async function analyseTake(take) {
  const generation = ++take.generation;
  const regions = findSounds(take.samples, take.sr, params());
  const previous = new Map(take.slices.map((s) => [s.start, s]));
  const name = take.nameInput.value;
  const slices = [];
  for (const [i, [start, end]] of regions.entries()) {
    const key = `${start}:${end}`;
    let analysis = take.cache.get(key);
    if (analysis == null) {
      if (i % 4 === 0) {
        status(`Finding the pitch in ${name}: ${i + 1} of ${regions.length}…`);
        await new Promise((r) => setTimeout(r)); // keep the page responsive
      }
      if (generation !== take.generation) return;
      analysis = analyse(take.samples.subarray(start, end), take.sr);
      take.cache.set(key, analysis);
    }
    // A sound that starts at the same place keeps what you already chose for it.
    const old = previous.get(start);
    slices.push({
      start,
      end,
      analysis,
      pitchHz: old?.pitchHz ?? analysis.candidates[0]?.hz ?? null,
      confirmed: old?.confirmed ?? false,
      keep: old?.keep ?? true,
      name: old?.name ?? '',
    });
  }
  if (generation !== take.generation) return;
  take.slices = slices;
  const seconds = (take.samples.length / take.sr).toFixed(1);
  take.info.textContent = slices.length === 1
    ? `${seconds} s · 1 sound.`
    : `${seconds} s · split into ${slices.length} sounds at the silences.`;
  drawWave(take);
  take.list.replaceChildren(...slices.map((_, i) => sliceRow(take, i)));
  updateReviewSummary();
  status(`${name}: ${slices.length} sound${slices.length === 1 ? '' : 's'} ready below. Check each pitch, then add them to the library.`);
}

function resplitAll() {
  for (const take of takes) analyseTake(take);
}

function defaultName(take, index) {
  const source = take.nameInput.value.trim() || 'Sound';
  return take.slices.length === 1 ? source : `${source} ${String(index + 1).padStart(2, '0')}`;
}

function drawWave(take) {
  const canvas = take.canvas;
  if (canvas.clientWidth === 0) return;
  const ratio = window.devicePixelRatio ?? 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  const g = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const { width, height } = canvas;
  const x = take.samples;
  const perPx = x.length / width;
  g.clearRect(0, 0, width, height);
  g.fillStyle = css.getPropertyValue('--region');
  for (const s of take.slices) {
    if (s.keep) g.fillRect(s.start / perPx, 0, Math.max(1, (s.end - s.start) / perPx), height);
  }
  g.fillStyle = css.getPropertyValue('--region-line');
  for (const s of take.slices) if (s.keep) g.fillRect(s.start / perPx, 0, ratio, height);
  let peak = 1e-6;
  for (let i = 0; i < x.length; i += 7) peak = Math.max(peak, Math.abs(x[i]));
  g.fillStyle = css.getPropertyValue('--wave');
  for (let px = 0; px < width; px++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(x.length, Math.floor((px + 1) * perPx));
    for (let i = Math.floor(px * perPx); i < end; i++) {
      if (x[i] < lo) lo = x[i];
      if (x[i] > hi) hi = x[i];
    }
    const top = height / 2 - (hi / peak) * (height / 2 - 2);
    const bottom = height / 2 - (lo / peak) * (height / 2 - 2);
    g.fillRect(px, top, 1, Math.max(1, bottom - top));
  }
}

function pitchChips(candidates, chosenHz, confirmed, onPick) {
  return el('div', { className: 'chips' }, ...candidates.map((c) => {
    const on = chosenHz != null && Math.abs(c.hz - chosenHz) < 0.01;
    return el('button', {
      type: 'button',
      className: `chip${on ? ' on' : ''}${on && !confirmed ? ' unsure' : ''}`,
      textContent: `${formatNote(c.hz)} · ${Math.round(c.hz)} Hz`,
      title: `Stands ${Math.round(c.prominenceDb)} dB above the rest of the sound`,
      onclick: () => onPick(c.hz),
    });
  }));
}

function playSlice(take, slice, row) {
  row?.classList.add('playing');
  playSamples(take.samples.subarray(slice.start, slice.end), take.sr, () => row?.classList.remove('playing'));
}

function sliceRow(take, i) {
  const s = take.slices[i];
  const row = el('li', { className: `item${s.keep ? '' : ' off'}` });
  const rerender = () => row.replaceWith(sliceRow(take, i));
  const name = el('input', {
    className: 'name',
    value: s.name,
    placeholder: defaultName(take, i),
    'aria-label': 'Name',
    oninput: (e) => (s.name = e.target.value),
  });
  const keep = el('input', {
    type: 'checkbox',
    checked: s.keep,
    onchange: (e) => {
      s.keep = e.target.checked;
      row.classList.toggle('off', !s.keep);
      drawWave(take);
      updateReviewSummary();
    },
  });
  row.append(
    el('button', { type: 'button', className: 'play', textContent: '▶', 'aria-label': 'Play', onclick: () => playSlice(take, s, row) }),
    el('div', { className: 'main' },
      el('div', { className: 'line1' },
        el('b', { textContent: `#${i + 1} ` }),
        `${(s.start / take.sr).toFixed(2)} s · ${((s.end - s.start) / take.sr).toFixed(2)} s `,
        s.confirmed ? null : el('span', { className: 'q', textContent: '?' })),
      s.analysis.candidates.length > 0
        ? pitchChips(s.analysis.candidates, s.pitchHz, s.confirmed, (hz) => {
          s.pitchHz = hz;
          s.confirmed = true;
          rerender();
        })
        : el('div', { className: 'line2', textContent: 'No pitch found' }),
      name),
    el('label', { className: 'keep' }, keep, 'Keep'),
  );
  return row;
}

function clearTakes() {
  stopPlayback();
  for (const take of [...takes]) removeTake(take);
}

async function addTakesToLibrary() {
  const kept = takes.flatMap((take) => take.slices.map((s, i) => ({ take, s, i })).filter(({ s }) => s.keep));
  if (kept.length === 0) return;
  const button = $('btnAdd');
  button.disabled = true;
  const known = new Set(view().sounds.map((s) => s.hash));
  let skipped = 0;
  try {
    for (const [n, { take, s, i }] of kept.entries()) {
      button.textContent = `Adding ${n + 1} of ${kept.length}…`;
      const wav = await makePreview(take.samples.subarray(s.start, s.end), take.sr);
      const hash = await sha256Hex(wav);
      if (known.has(hash)) {
        skipped++;
        continue;
      }
      known.add(hash);
      const id = `new-${++state.tempId}`;
      state.wavs.set(id, wav);
      state.previewUrls.set(id, URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
      state.pending.added.push({
        id,
        name: s.name.trim() || defaultName(take, i),
        source: take.nameInput.value.trim() || 'Untitled',
        sourceFile: take.sourceFile,
        startSec: round(s.start / take.sr, 3),
        endSec: round(s.end / take.sr, 3),
        durationSec: round((s.end - s.start) / take.sr, 3),
        added: today(),
        pitchHz: round(s.pitchHz, 2),
        pitchConfirmed: s.confirmed,
        candidates: s.analysis.candidates.map((c) => ({ hz: round(c.hz, 2), prominenceDb: round(c.prominenceDb, 1) })),
        centroidHz: round(s.analysis.centroidHz, 1),
        peak: round(s.analysis.peak, 4),
        notes: '',
        hash,
      });
    }
  } finally {
    button.disabled = false;
    updateReviewSummary();
  }
  const added = kept.length - skipped;
  if (added === 0) {
    status(`All ${skipped} sounds are already in the library.`);
    return;
  }
  clearTakes();
  renderLibrary();
  const also = skipped > 0 ? ` ${skipped} were already there.` : '';
  status(`${added} sound${added === 1 ? '' : 's'} added to the library.${also} Tap “Save to GitHub” to keep them.`);
  $('library').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ------------------------------------------------------------------ library

function sortedSounds(doc) {
  const order = $('orderSel').value;
  const source = $('sourceSel').value;
  let sounds = doc.sounds.filter((s) => source === '' || s.source === source);
  if (order.startsWith('saved:')) {
    const byId = new Map(sounds.map((s) => [s.id, s]));
    return doc.sorts[Number(order.slice(6))].ids.map((id) => byId.get(id)).filter((s) => s != null);
  }
  if (order === 'added') return sounds;
  const dir = order === 'pitch-desc' ? -1 : 1;
  sounds = [...sounds];
  sounds.sort((a, b) => {
    if (a.pitchHz == null || b.pitchHz == null) return (a.pitchHz == null) - (b.pitchHz == null);
    return dir * (a.pitchHz - b.pitchHz);
  });
  return sounds;
}

function fillSelect(select, options) {
  const value = select.value;
  select.replaceChildren(...options.map(([v, label]) => el('option', { value: v, textContent: label })));
  if (options.some(([v]) => v === value)) select.value = value;
}

function previewUrl(sound) {
  return state.previewUrls.get(sound.id) ?? sound.preview;
}

function renderLibrary() {
  const doc = view();
  fillSelect($('orderSel'), [
    ['pitch-asc', 'Pitch, low → high'],
    ['pitch-desc', 'Pitch, high → low'],
    ['added', 'Order added'],
    ...doc.sorts.map((o, i) => [`saved:${i}`, `Saved: ${o.name}`]),
  ]);
  const sources = [...new Set(doc.sounds.map((s) => s.source))].sort();
  fillSelect($('sourceSel'), [['', 'All sources'], ...sources.map((s) => [s, s])]);
  const sounds = sortedSounds(doc);
  $('libList').replaceChildren(...sounds.map((s, i) => libraryRow(s, i)));
  $('libEmpty').hidden = sounds.length > 0;
  $('libCount').textContent = doc.sounds.length > 0 ? String(doc.sounds.length) : '';
  const changes = pendingCount();
  $('saveBar').hidden = changes === 0;
  $('saveText').textContent = `${changes} unsaved change${changes === 1 ? '' : 's'}`;
}

function libraryRow(s, index) {
  const open = state.openId === s.id;
  const row = el('li', { className: `item${state.playingId === s.id ? ' playing' : ''}` });
  row.dataset.id = s.id;
  row.append(
    el('span', { className: 'rank', textContent: String(index + 1) }),
    el('button', { type: 'button', className: 'play', textContent: '▶', 'aria-label': 'Play', onclick: () => playOne(s) }),
    el('div', { className: 'main' },
      el('div', { className: 'line1' },
        el('b', { textContent: formatNote(s.pitchHz) }),
        s.pitchHz != null ? ` · ${s.pitchHz.toFixed(1)} Hz ` : ' ',
        s.pitchConfirmed ? null : el('span', { className: 'q', textContent: '?', title: 'Pitch not confirmed by ear' })),
      el('div', { className: 'line2', textContent: s.name }),
      el('div', {
        className: 'line2',
        textContent: [
          s.name.startsWith(s.source) ? null : s.source,
          `${s.durationSec.toFixed(2)} s`,
          s.id.startsWith('new-') ? 'not saved yet' : s.id,
        ].filter((x) => x != null).join(' · '),
      })),
    el('button', {
      type: 'button',
      textContent: open ? 'Close' : 'Edit',
      onclick: () => {
        state.openId = open ? null : s.id;
        renderLibrary();
      },
    }),
  );
  if (open) row.append(libraryDetails(s));
  return row;
}

function libraryDetails(s) {
  return el('div', { className: 'details' },
    s.candidates.length > 0
      ? pitchChips(s.candidates, s.pitchHz, s.pitchConfirmed, (hz) => editSound(s.id, { pitchHz: hz, pitchConfirmed: true }))
      : null,
    el('label', { className: 'field', style: 'margin-top:0.75rem' }, 'Name',
      el('input', { value: s.name, onchange: (e) => editSound(s.id, { name: e.target.value.trim() || s.name }) })),
    el('label', { className: 'field' }, 'Notes',
      el('textarea', { value: s.notes, onchange: (e) => editSound(s.id, { notes: e.target.value }) })),
    el('p', {
      className: 'hint',
      textContent: `From ${s.sourceFile ?? 'a recording'}${s.startSec != null ? ` at ${s.startSec.toFixed(2)} s` : ''}, added ${s.added}. Brightness ${Math.round(s.centroidHz ?? 0)} Hz.`,
    }),
    el('div', { className: 'row end' },
      el('button', {
        type: 'button',
        className: 'danger',
        textContent: 'Delete',
        onclick: () => {
          if (confirm(`Delete “${s.name}” from the library?`)) deleteSound(s.id);
        },
      })),
  );
}

function setPlaying(id) {
  state.playingId = id;
  for (const row of $('libList').children) row.classList.toggle('playing', row.dataset.id === id);
}

function playOne(s) {
  stopPlayAll();
  setPlaying(s.id);
  playUrl(previewUrl(s), () => setPlaying(null));
}

let playAllToken = 0;
function stopPlayAll() {
  playAllToken++;
  $('btnPlayAll').textContent = '▶ Play in order';
}

function togglePlayAll() {
  if ($('btnPlayAll').textContent.startsWith('■')) {
    stopPlayAll();
    stopPlayback();
    setPlaying(null);
    return;
  }
  const token = ++playAllToken;
  const sounds = sortedSounds(view());
  $('btnPlayAll').textContent = '■ Stop';
  const next = (i) => {
    if (token !== playAllToken) return;
    if (i >= sounds.length) {
      stopPlayAll();
      setPlaying(null);
      return;
    }
    setPlaying(sounds[i].id);
    $('libList').children[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    playUrl(previewUrl(sounds[i]), () => setTimeout(() => next(i + 1), 250));
  };
  next(0);
}

function saveOrder() {
  const sounds = sortedSounds(view());
  if (sounds.length === 0) return;
  const label = $('orderSel').selectedOptions[0]?.textContent ?? '';
  const name = prompt('Name for this order', `${label} · ${today()}`);
  if (name == null || name.trim() === '') return;
  state.pending.sorts.push({ name: name.trim(), date: today(), ids: sounds.map((s) => s.id) });
  renderLibrary();
  toast('Order saved. Save to GitHub to keep it.');
}

async function exportZip() {
  const sounds = sortedSounds(view());
  if (sounds.length === 0 || window.JSZip == null) return;
  const button = $('btnExport');
  button.disabled = true;
  try {
    const zip = new window.JSZip();
    const csv = [['rank', 'id', 'name', 'source', 'pitch_hz', 'note', 'confirmed', 'duration_s', 'file']];
    for (const [i, s] of sounds.entries()) {
      button.textContent = `Packing ${i + 1}/${sounds.length}…`;
      const note = formatNote(s.pitchHz).replace(/[ ¢]/g, '').replace('♯', 's').replace('−', 'm');
      const file = `${String(i + 1).padStart(3, '0')}_${s.id}_${note}.wav`;
      const response = await fetch(previewUrl(s));
      if (!response.ok) throw new Error(`${s.name}: ${response.status}`);
      zip.file(file, await response.arrayBuffer());
      csv.push([i + 1, s.id, s.name, s.source, s.pitchHz ?? '', formatNote(s.pitchHz), s.pitchConfirmed, s.durationSec, file]);
    }
    const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    zip.file('order.csv', csv.map((r) => r.map(cell).join(',')).join('\n') + '\n');
    const blob = await zip.generateAsync({ type: 'blob' });
    const link = el('a', { href: URL.createObjectURL(blob), download: `sound-sort-${today()}.zip` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  } catch (e) {
    toast(`Couldn't build the zip: ${e.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Download zip';
  }
}

// ------------------------------------------------------------------ saving

// One sound per line, so each change shows up clearly in the git history.
function stringifyLibrary(doc) {
  const lines = (items) => (items.length === 0 ? '[]' : `[\n${items.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`);
  return `{\n  "format": ${JSON.stringify(doc.format)},\n  "nextId": ${doc.nextId},\n  "sounds": ${lines(doc.sounds)},\n  "sorts": ${lines(doc.sorts)}\n}\n`;
}

async function save() {
  const gh = repo();
  if (gh == null) {
    toggleSettings(true);
    toast('Add a GitHub token first.');
    return;
  }
  const button = $('btnSave');
  button.disabled = true;
  button.textContent = 'Saving…';
  const p = state.pending;
  const summary = [
    p.added.length > 0 ? `add ${p.added.length} sound${p.added.length === 1 ? '' : 's'}` : null,
    p.edits.size > 0 ? `edit ${p.edits.size}` : null,
    p.deleted.size > 0 ? `delete ${p.deleted.size}` : null,
    p.sorts.length > 0 ? `save ${p.sorts.length} order${p.sorts.length === 1 ? '' : 's'}` : null,
  ].filter((x) => x != null).join(', ');
  let result = null;
  try {
    await gh.commit(`Library: ${summary}`, async (head) => {
      const text = await gh.readText(LIBRARY_PATH, head);
      const base = text != null ? JSON.parse(text) : emptyLibrary();
      result = merge(base, p, true);
      const files = [{ path: LIBRARY_PATH, text: stringifyLibrary(result.doc) }];
      for (const [temp, id] of result.idMap) files.push({ path: `library/previews/${id}.wav`, bytes: state.wavs.get(temp) });
      for (const id of p.deleted) {
        if (base.sounds.some((s) => s.id === id)) files.push({ path: `library/previews/${id}.wav`, delete: true });
      }
      return files;
    }, (i, n) => (button.textContent = `Uploading ${i}/${n}…`));
  } catch (e) {
    toast(`Not saved: ${e.message}`, true);
    button.disabled = false;
    button.textContent = 'Save to GitHub';
    return;
  }
  for (const [temp, id] of result.idMap) state.previewUrls.set(id, state.previewUrls.get(temp));
  if (state.openId != null) state.openId = result.idMap.get(state.openId) ?? state.openId;
  state.library = result.doc;
  state.pending = { added: [], edits: new Map(), deleted: new Set(), sorts: [] };
  state.wavs.clear();
  button.disabled = false;
  button.textContent = 'Save to GitHub';
  renderLibrary();
  toast('Saved to GitHub.');
}

// ------------------------------------------------------------------ settings

function showSettings() {
  $('ghOwner').value = settings.owner;
  $('ghRepo').value = settings.repo;
  $('ghBranch').value = settings.branch;
  $('ghToken').value = settings.token;
  $('ghStatus').textContent = settings.token !== '' ? 'A token is saved in this browser.' : 'No token saved yet.';
}

async function testSettings() {
  settings = {
    owner: $('ghOwner').value.trim(),
    repo: $('ghRepo').value.trim(),
    branch: $('ghBranch').value.trim() || 'main',
    token: $('ghToken').value.trim(),
  };
  const stored = storeSettings(settings);
  const gh = repo();
  if (gh == null) {
    $('ghStatus').textContent = 'Paste a token first.';
    return;
  }
  $('ghStatus').textContent = 'Checking…';
  try {
    const ok = await gh.canWrite();
    $('ghStatus').textContent = ok
      ? `Connected. This browser can save to ${settings.owner}/${settings.repo}.${stored ? '' : ' This browser blocks storage, so the token is forgotten when you close the page.'}`
      : 'The token can read this repository but not save to it. Give it Contents: Read and write.';
    if (ok) await loadLibrary();
  } catch (e) {
    $('ghStatus').textContent = `Didn't work: ${e.message}`;
  }
}

function forgetToken() {
  settings = { ...settings, token: '' };
  storeSettings(settings);
  showSettings();
}

// ------------------------------------------------------------------ wiring

function init() {
  $('btnSettings').addEventListener('click', () => toggleSettings());
  $('btnListen').addEventListener('click', toggleListen);
  $('btnRecord').addEventListener('click', toggleRecord);
  $('fileInput').addEventListener('change', onFiles);

  for (const id of ['topDb', 'minGap', 'tail']) {
    $(id).addEventListener('input', showParams);
    $(id).addEventListener('change', resplitAll);
  }
  showParams();
  $('btnClear').addEventListener('click', () => {
    if (confirm('Remove all the sounds waiting to be added?')) clearTakes();
  });
  $('btnAdd').addEventListener('click', addTakesToLibrary);

  $('orderSel').addEventListener('change', renderLibrary);
  $('sourceSel').addEventListener('change', renderLibrary);
  $('btnPlayAll').addEventListener('click', togglePlayAll);
  $('btnSaveOrder').addEventListener('click', saveOrder);
  $('btnExport').addEventListener('click', exportZip);
  $('btnSave').addEventListener('click', save);

  $('btnTest').addEventListener('click', testSettings);
  $('btnForget').addEventListener('click', forgetToken);
  showSettings();

  window.addEventListener('resize', () => takes.forEach(drawWave));
  window.addEventListener('beforeunload', (e) => {
    if (pendingCount() > 0 || takes.length > 0 || mic.recording) e.preventDefault();
  });

  window.soundSortReady = true;
  loadLibrary();
}

init();
