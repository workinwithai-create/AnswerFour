const CDN = "https://cdn.jsdelivr.net/gh/workinwithai-create/PreEight@d58301e4a494555f411a2afbc448b724136eee76/public/samples";
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const BARS = 4;
const STEPS_PER_BAR = 16;
const SAMPLE_RATE = 48000;

const recipes = [
  { id:"piano-trumpet", name:"Piano → Trumpet", blurb:"Piano calls on 1 and 3. Trumpet answers on 2 and 4." },
  { id:"nylon-violin", name:"Nylon → Violin", blurb:"Nylon arpeggio call. Violin holds the answer." },
  { id:"bass-answer", name:"Bass answers", blurb:"Sparse piano call. Bass walks the response." },
  { id:"kit-call", name:"Kit call", blurb:"Kick-snare call. Trumpet and violin answer together." },
  { id:"full-chat", name:"Full chat", blurb:"All chairs take turns. Conversation across four bars." }
];

const state = {
  bpm: 96,
  key: "C",
  chords: ["Am","F","C","G"],
  recipe: recipes[0],
  gains: { piano:0.6, guitar:0.5, bass:0.55, trumpet:0.45, violin:0.4, kit:0.5 },
  playing: false,
  step: 0,
  nextStepTime: 0
};

let ctx, master, compressor, chairGains = {}, buffers = {}, rawBuffers = {}, activeSources = [], timerId = null, rafId = null;

const sampleMap = {
  kick: "drums/kick.mp3",
  snare: "drums/snare.mp3",
  hat: "drums/hihat.mp3",
  crash: "drums/crash.mp3",
  piano: ["piano/C2.mp3","piano/C3.mp3","piano/C4.mp3","piano/C5.mp3","piano/E3.mp3","piano/G3.mp3","piano/A3.mp3"],
  guitar: ["guitar/E2.mp3","guitar/A2.mp3","guitar/E3.mp3","guitar/A3.mp3","guitar/E4.mp3"],
  bass: ["bass/E1.mp3","bass/A1.mp3","bass/C2.mp3","bass/E2.mp3","bass/A2.mp3"],
  trumpet: ["trumpet/C4.mp3","trumpet/E4.mp3","trumpet/G4.mp3","trumpet/A3.mp3","trumpet/C5.mp3"],
  violin: ["violin/A3.mp3","violin/C4.mp3","violin/E4.mp3","violin/G3.mp3","violin/A4.mp3"]
};

function midiToName(midi) {
  const notes = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  return notes[midi % 12] + Math.floor(midi / 12);
}

function parseChord(sym, rootOffset = 0) {
  const map = { C:0,"C#":1,Db:1,D:2,"D#":3,Eb:3,E:4,F:5,"F#":6,Gb:6,G:7,"G#":8,Ab:8,A:9,"A#":10,Bb:10,B:11 };
  const m = sym.match(/^([A-G][#b]?)(m|maj|min|7|maj7|m7)?/);
  if (!m) return [60,64,67];
  let root = (map[m[1]] || 0) + rootOffset;
  const isMin = /m/.test(m[2] || "");
  const third = isMin ? 3 : 4;
  return [root+60, root+60+third, root+60+7];
}

function keyOffset() {
  const map = { C:0,"C#":1,D:2,"D#":3,E:4,F:5,"F#":6,G:7,"G#":8,A:9,"A#":10,B:11 };
  return map[state.key] || 0;
}

function closestSample(family, midi) {
  const list = sampleMap[family];
  if (!Array.isArray(list)) return null;
  let best = null, bestDist = 99;
  for (const path of list) {
    const baseName = path.split("/").pop().replace(".mp3","");
    const baseMidi = nameToMidi(baseName);
    const dist = Math.abs(midi - baseMidi);
    if (dist < bestDist && dist <= 4) {
      bestDist = dist;
      best = { path, baseMidi, rate: Math.pow(2, (midi - baseMidi)/12) };
    }
  }
  return best;
}

function nameToMidi(name) {
  const notes = {C:0,"C#":1,Db:1,D:2,"D#":3,Eb:3,E:4,F:5,"F#":6,Gb:6,G:7,"G#":8,Ab:8,A:9,"A#":10,Bb:10,B:11};
  const m = name.match(/^([A-G][#b]?)(\d)/);
  if (!m) return 60;
  return notes[m[1]] + parseInt(m[2])*12;
}

async function loadSamples() {
  const status = document.getElementById("status");
  const toLoad = [];
  toLoad.push(["kick", sampleMap.kick]);
  toLoad.push(["snare", sampleMap.snare]);
  toLoad.push(["hat", sampleMap.hat]);
  toLoad.push(["crash", sampleMap.crash]);
  for (const fam of ["piano","guitar","bass","trumpet","violin"]) {
    for (const p of sampleMap[fam]) toLoad.push([fam+"-"+p, p]);
  }
  let n = 0;
  const missing = [];
  for (const [key, path] of toLoad) {
    try {
      const r = await fetch(`${CDN}/${path}`);
      if (!r.ok) throw new Error(r.status);
      const ab = await r.arrayBuffer();
      rawBuffers[key] = ab.slice(0);
      buffers[key] = await ctx.decodeAudioData(ab.slice(0));
    } catch (e) {
      missing.push(key.split("-")[0] || key);
    }
    n++;
    status.textContent = `Loading ${n}/${toLoad.length}`;
  }
  if (missing.length) {
    status.textContent = `Missing: ${[...new Set(missing)].join(", ")}`;
    return false;
  }
  status.textContent = "Chairs seated · live FluidR3";
  return true;
}

function ensureCtx() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -1;
    compressor.knee.value = 0;
    compressor.ratio.value = 20;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    master.connect(compressor);
    compressor.connect(ctx.destination);
    for (const chair of ["piano","guitar","bass","trumpet","violin","kit"]) {
      chairGains[chair] = ctx.createGain();
      chairGains[chair].gain.value = state.gains[chair];
      chairGains[chair].connect(master);
    }
  }
  if (ctx.state === "suspended") ctx.resume();
}

function playSample(key, when, rate = 1, gain = 0.4, chair = "kit", duration = null, audioCtx = ctx, bufs = buffers, gains = chairGains, sources = activeSources) {
  const b = bufs[key];
  if (!b || !audioCtx) return null;
  const src = audioCtx.createBufferSource();
  src.buffer = b;
  src.playbackRate.value = rate;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.01);
  if (duration) {
    g.gain.setValueAtTime(gain, when + duration - 0.02);
    g.gain.linearRampToValueAtTime(0, when + duration);
  } else {
    g.gain.linearRampToValueAtTime(0, when + 0.4);
  }
  src.connect(g);
  g.connect(gains[chair] || master);
  src.start(when);
  if (duration) src.stop(when + duration + 0.05);
  if (sources) {
    sources.push(src);
    src.onended = () => { const i = sources.indexOf(src); if (i>=0) sources.splice(i,1); };
  }
  return src;
}

function scheduleStep(step, time, audioCtx = ctx, bufs = buffers, gains = chairGains, sources = activeSources) {
  const bar = Math.floor(step / STEPS_PER_BAR) % BARS;
  const s = step % STEPS_PER_BAR;
  const off = keyOffset();
  const chord = parseChord(state.chords[bar] || "C", off);
  const rec = state.recipe.id;
  const stepDur = 60 / state.bpm / 4;

  if (s % 4 === 0) playSample("kick", time, 1, 0.7 * state.gains.kit, "kit", null, audioCtx, bufs, gains, sources);
  if (s === 8) playSample("snare", time, 1, 0.5 * state.gains.kit, "kit", null, audioCtx, bufs, gains, sources);
  if (s % 2 === 0) playSample("hat", time, 1, 0.15 * state.gains.kit, "kit", null, audioCtx, bufs, gains, sources);

  const isCall = bar % 2 === 0;
  if (rec === "piano-trumpet") {
    if (isCall && s === 0) {
      const p = closestSample("piano", chord[0]);
      if (p) playSample("piano-"+p.path, time, p.rate, 0.5 * state.gains.piano, "piano", stepDur*4, audioCtx, bufs, gains, sources);
    }
    if (!isCall && s === 0) {
      const t = closestSample("trumpet", chord[2] + 12);
      if (t) playSample("trumpet-"+t.path, time, t.rate, 0.45 * state.gains.trumpet, "trumpet", stepDur*8, audioCtx, bufs, gains, sources);
    }
  } else if (rec === "nylon-violin") {
    if (isCall && (s === 0 || s === 4 || s === 8 || s === 12)) {
      const g = closestSample("guitar", chord[Math.floor(s/4) % 3]);
      if (g) playSample("guitar-"+g.path, time, g.rate, 0.4 * state.gains.guitar, "guitar", null, audioCtx, bufs, gains, sources);
    }
    if (!isCall && s === 0) {
      const v = closestSample("violin", chord[1]);
      if (v) playSample("violin-"+v.path, time, v.rate, 0.4 * state.gains.violin, "violin", stepDur*16, audioCtx, bufs, gains, sources);
    }
  } else if (rec === "bass-answer") {
    if (isCall && s === 0) {
      const p = closestSample("piano", chord[0]);
      if (p) playSample("piano-"+p.path, time, p.rate, 0.35 * state.gains.piano, "piano", null, audioCtx, bufs, gains, sources);
    }
    if (!isCall && (s === 0 || s === 8)) {
      const b = closestSample("bass", chord[0] - 24);
      if (b) playSample("bass-"+b.path, time, b.rate, 0.5 * state.gains.bass, "bass", null, audioCtx, bufs, gains, sources);
    }
  } else if (rec === "kit-call") {
    if (isCall && s === 0) playSample("kick", time, 1, 0.8 * state.gains.kit, "kit", null, audioCtx, bufs, gains, sources);
    if (isCall && s === 8) playSample("snare", time, 1, 0.6 * state.gains.kit, "kit", null, audioCtx, bufs, gains, sources);
    if (!isCall && s === 0) {
      const t = closestSample("trumpet", chord[2]);
      if (t) playSample("trumpet-"+t.path, time, t.rate, 0.4 * state.gains.trumpet, "trumpet", null, audioCtx, bufs, gains, sources);
      const v = closestSample("violin", chord[1]);
      if (v) playSample("violin-"+v.path, time, v.rate, 0.35 * state.gains.violin, "violin", null, audioCtx, bufs, gains, sources);
    }
  } else {
    if (s === 0) {
      if (bar === 0) {
        const p = closestSample("piano", chord[0]);
        if (p) playSample("piano-"+p.path, time, p.rate, 0.45 * state.gains.piano, "piano", null, audioCtx, bufs, gains, sources);
      } else if (bar === 1) {
        const t = closestSample("trumpet", chord[2]);
        if (t) playSample("trumpet-"+t.path, time, t.rate, 0.4 * state.gains.trumpet, "trumpet", null, audioCtx, bufs, gains, sources);
      } else if (bar === 2) {
        const g = closestSample("guitar", chord[1]);
        if (g) playSample("guitar-"+g.path, time, g.rate, 0.4 * state.gains.guitar, "guitar", null, audioCtx, bufs, gains, sources);
      } else {
        const b = closestSample("bass", chord[0]-24);
        if (b) playSample("bass-"+b.path, time, b.rate, 0.5 * state.gains.bass, "bass", null, audioCtx, bufs, gains, sources);
      }
    }
  }
}

function scheduler() {
  while (state.nextStepTime < ctx.currentTime + SCHEDULE_AHEAD) {
    scheduleStep(state.step, state.nextStepTime);
    const stepDur = 60 / state.bpm / 4;
    state.nextStepTime += stepDur;
    state.step = (state.step + 1) % (BARS * STEPS_PER_BAR);
  }
}

function start() {
  ensureCtx();
  if (ctx.state !== "running") {
    document.getElementById("status").textContent = "Tap to start audio…";
    return;
  }
  stop();
  state.playing = true;
  state.nextStepTime = ctx.currentTime + 0.1;
  state.step = 0;
  timerId = setInterval(scheduler, LOOKAHEAD_MS);
  paintBars();
  rafId = requestAnimationFrame(updatePlayhead);
}

function stop() {
  state.playing = false;
  if (timerId) clearInterval(timerId);
  timerId = null;
  if (rafId) cancelAnimationFrame(rafId);
  activeSources.forEach(s => { try { s.stop(); } catch(e){} });
  activeSources = [];
  paintBars();
}

function updatePlayhead() {
  if (!state.playing) return;
  paintBars();
  rafId = requestAnimationFrame(updatePlayhead);
}

function paintBars() {
  const el = document.getElementById("bars");
  el.innerHTML = "";
  for (let i = 0; i < BARS; i++) {
    const d = document.createElement("div");
    const active = state.playing && Math.floor(state.step / STEPS_PER_BAR) % BARS === i;
    d.className = "bar" + (active ? " active" : "");
    d.innerHTML = `<div class="n">${i+1}</div><div class="c">${state.chords[i] || ""}</div>`;
    el.appendChild(d);
  }
}

function paintRecipes() {
  const el = document.getElementById("recipes");
  el.innerHTML = "";
  recipes.forEach(r => {
    const b = document.createElement("button");
    b.className = "card" + (state.recipe.id === r.id ? " on" : "");
    b.innerHTML = `<b>${r.name}</b><span>${r.blurb}</span>`;
    b.onclick = () => { state.recipe = r; save(); render(); };
    el.appendChild(b);
  });
}

function punch() {
  return `AnswerFour punch list\n${state.bpm} BPM · ${state.key} · ${state.recipe.name}\n\nThe problem: the loop has a call and nothing answers. Session players write four live bars of conversation.\nThe move: ${state.recipe.blurb}\n\nChords\n${state.chords.map((c,i)=>`  ${i+1}. ${c}`).join("\n")}\n\nLive chairs only. Distinct from TagFour, LiftTwo, PreEight, AfterHook, EndEight, LastHook.\nDrop the WAV on bar 1 of your session. It loops clean.`;
}

function render() {
  paintRecipes();
  paintBars();
  document.getElementById("punch").textContent = punch();
  document.getElementById("bpm").value = state.bpm;
  document.getElementById("key").value = state.key;
  document.getElementById("chords").value = state.chords.join(" ");
  for (const k of Object.keys(state.gains)) {
    const el = document.getElementById("gain" + k.charAt(0).toUpperCase() + k.slice(1));
    if (el) el.value = state.gains[k];
  }
}

function save() {
  localStorage.setItem("answerfour", JSON.stringify({
    bpm: state.bpm, key: state.key, chords: state.chords, recipe: state.recipe.id, gains: state.gains
  }));
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem("answerfour") || "{}");
    if (s.bpm) state.bpm = s.bpm;
    if (s.key) state.key = s.key;
    if (s.chords) state.chords = s.chords;
    if (s.recipe) state.recipe = recipes.find(r => r.id === s.recipe) || recipes[0];
    if (s.gains) state.gains = s.gains;
  } catch(e) {}
}

async function decodeAll(offlineCtx) {
  const offBuffers = {};
  for (const [key, ab] of Object.entries(rawBuffers)) {
    try {
      offBuffers[key] = await offlineCtx.decodeAudioData(ab.slice(0));
    } catch (e) {
      console.warn("decode fail", key);
    }
  }
  return offBuffers;
}

function makeOfflineGraph(offlineCtx, offBuffers) {
  const offMaster = offlineCtx.createGain();
  const offComp = offlineCtx.createDynamicsCompressor();
  offComp.threshold.value = -1;
  offComp.knee.value = 0;
  offComp.ratio.value = 20;
  offComp.attack.value = 0.003;
  offComp.release.value = 0.25;
  offMaster.connect(offComp);
  offComp.connect(offlineCtx.destination);
  const offGains = {};
  for (const chair of ["piano","guitar","bass","trumpet","violin","kit"]) {
    offGains[chair] = offlineCtx.createGain();
    offGains[chair].gain.value = state.gains[chair];
    offGains[chair].connect(offMaster);
  }
  return { offGains };
}

async function exportWav() {
  if (Object.keys(rawBuffers).length === 0) {
    document.getElementById("status").textContent = "Load samples first (tap Play)";
    return;
  }
  const status = document.getElementById("status");
  status.textContent = "Rendering WAV…";
  const sampleRate = SAMPLE_RATE;
  const mainLength = Math.round(BARS * 4 * 60 / state.bpm * sampleRate);
  const tailSec = 1.5;
  const tailSamples = Math.round(tailSec * sampleRate);
  const totalLength = mainLength + tailSamples;
  const offline = new OfflineAudioContext(2, totalLength, sampleRate);
  const offBuffers = await decodeAll(offline);
  const { offGains } = makeOfflineGraph(offline, offBuffers);
  let t = 0;
  const stepDur = 60 / state.bpm / 4;
  const totalSteps = BARS * STEPS_PER_BAR;
  for (let i = 0; i < totalSteps; i++) {
    scheduleStep(i, t, offline, offBuffers, offGains, null);
    t += stepDur;
  }
  const rendered = await offline.startRendering();
  // Fold tail onto start for seamless loop
  const out = offline.createBuffer(2, mainLength, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const src = rendered.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < mainLength; i++) dst[i] = src[i];
    for (let i = 0; i < tailSamples && i < mainLength; i++) {
      dst[i] += src[mainLength + i] * 0.85; // gentle fold
    }
  }
  // Peak normalize to -1 dBFS
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const data = out.getChannelData(ch);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  const target = Math.pow(10, -1 / 20); // -1 dBFS
  const scale = peak > target ? target / peak : 1;
  if (scale < 1) {
    for (let ch = 0; ch < 2; ch++) {
      const data = out.getChannelData(ch);
      for (let i = 0; i < data.length; i++) data[i] *= scale;
    }
  }
  const blob = encodeWav24(out, sampleRate);
  const name = `answerfour-${state.recipe.id}-${state.bpm}bpm-${state.key}.wav`;
  downloadBlob(blob, name);
  status.textContent = `WAV ready · ${mainLength} samples · first downbeat at 0`;
}

function encodeWav24(buffer, rate) {
  const numCh = buffer.numberOfChannels;
  const len = buffer.length;
  const bytesPerSample = 3;
  const dataSize = len * numCh * bytesPerSample;
  const bufferSize = 44 + dataSize;
  const view = new DataView(new ArrayBuffer(bufferSize));
  writeString(view, 0, "RIFF");
  view.setUint32(4, bufferSize - 8, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * numCh * bytesPerSample, true);
  view.setUint16(32, numCh * bytesPerSample, true);
  view.setUint16(34, 24, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      let sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      sample = sample < 0 ? sample * 0x800000 : sample * 0x7FFFFF;
      const s = Math.round(sample);
      view.setUint8(offset, s & 0xFF);
      view.setUint8(offset + 1, (s >> 8) & 0xFF);
      view.setUint8(offset + 2, (s >> 16) & 0xFF);
      offset += 3;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
}

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function collectMidiEvents() {
  const tracks = {
    kit: [], piano: [], guitar: [], bass: [], trumpet: [], violin: []
  };
  let t = 0;
  const stepDur = 60 / state.bpm / 4;
  const ppq = 480;
  const ticksPerStep = Math.round(ppq * 4 * stepDur / (60 / state.bpm)); // approx
  // Better: use absolute ticks from time
  const ticksPerSecond = (state.bpm / 60) * ppq;
  for (let step = 0; step < BARS * STEPS_PER_BAR; step++) {
    const bar = Math.floor(step / STEPS_PER_BAR) % BARS;
    const s = step % STEPS_PER_BAR;
    const timeSec = t;
    const tick = Math.round(timeSec * ticksPerSecond);
    const off = keyOffset();
    const chord = parseChord(state.chords[bar] || "C", off);
    const rec = state.recipe.id;
    const isCall = bar % 2 === 0;
    // Simplified note collection matching scheduleStep intent
    if (s % 4 === 0) tracks.kit.push({ tick, note: 36, vel: 100, dur: 0.1 }); // kick
    if (s === 8) tracks.kit.push({ tick, note: 38, vel: 90, dur: 0.1 });
    if (s % 2 === 0) tracks.kit.push({ tick, note: 42, vel: 40, dur: 0.05 });
    if (rec === "piano-trumpet") {
      if (isCall && s === 0) tracks.piano.push({ tick, note: chord[0], vel: 80, dur: stepDur * 4 });
      if (!isCall && s === 0) tracks.trumpet.push({ tick, note: chord[2] + 12, vel: 75, dur: stepDur * 8 });
    } else if (rec === "nylon-violin") {
      if (isCall && (s % 4 === 0)) tracks.guitar.push({ tick, note: chord[Math.floor(s/4) % 3], vel: 70, dur: 0.2 });
      if (!isCall && s === 0) tracks.violin.push({ tick, note: chord[1], vel: 70, dur: stepDur * 16 });
    } else if (rec === "bass-answer") {
      if (isCall && s === 0) tracks.piano.push({ tick, note: chord[0], vel: 60, dur: 0.3 });
      if (!isCall && (s === 0 || s === 8)) tracks.bass.push({ tick, note: chord[0] - 24, vel: 80, dur: 0.3 });
    } else if (rec === "kit-call") {
      if (!isCall && s === 0) {
        tracks.trumpet.push({ tick, note: chord[2], vel: 70, dur: 0.4 });
        tracks.violin.push({ tick, note: chord[1], vel: 65, dur: 0.4 });
      }
    } else {
      if (s === 0) {
        if (bar === 0) tracks.piano.push({ tick, note: chord[0], vel: 75, dur: 0.4 });
        else if (bar === 1) tracks.trumpet.push({ tick, note: chord[2], vel: 70, dur: 0.4 });
        else if (bar === 2) tracks.guitar.push({ tick, note: chord[1], vel: 70, dur: 0.4 });
        else tracks.bass.push({ tick, note: chord[0] - 24, vel: 80, dur: 0.4 });
      }
    }
    t += stepDur;
  }
  return tracks;
}

function exportMidi() {
  const tracks = collectMidiEvents();
  const blob = buildMidi(tracks, state.bpm);
  const name = `answerfour-${state.recipe.id}-${state.bpm}bpm-${state.key}.mid`;
  downloadBlob(blob, name);
  document.getElementById("status").textContent = "MIDI ready · one track per chair · 4/4 · tempo set";
}

function buildMidi(tracks, bpm) {
  // Minimal multi-track SMF (format 1)
  const ppq = 480;
  const header = [0x4D, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x06, (ppq >> 8) & 0xFF, ppq & 0xFF]; // 6 tracks
  const trackNames = ["Kit", "Piano", "Guitar", "Bass", "Trumpet", "Violin"];
  const trackKeys = ["kit", "piano", "guitar", "bass", "trumpet", "violin"];
  let body = [];
  trackKeys.forEach((key, ti) => {
    const events = tracks[key] || [];
    const track = [];
    // Track name
    const name = trackNames[ti];
    track.push(0x00, 0xFF, 0x03, name.length, ...Array.from(name).map(c => c.charCodeAt(0)));
    // Tempo (only on first track)
    if (ti === 0) {
      const us = Math.round(60000000 / bpm);
      track.push(0x00, 0xFF, 0x51, 0x03, (us >> 16) & 0xFF, (us >> 8) & 0xFF, us & 0xFF);
      // Time sig 4/4
      track.push(0x00, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
    }
    events.sort((a, b) => a.tick - b.tick);
    let lastTick = 0;
    events.forEach(ev => {
      const delta = Math.max(0, ev.tick - lastTick);
      track.push(...varInt(delta), 0x90 + ti, ev.note & 0x7F, Math.min(127, ev.vel)); // note on
      const offTick = ev.tick + Math.round((ev.dur || 0.2) * (bpm / 60) * ppq);
      const offDelta = Math.max(1, offTick - ev.tick);
      track.push(...varInt(offDelta), 0x80 + ti, ev.note & 0x7F, 0x00); // note off
      lastTick = offTick;
    });
    track.push(0x00, 0xFF, 0x2F, 0x00); // end of track
    const len = track.length;
    body.push(0x4D, 0x54, 0x72, 0x6B, (len >> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF, ...track);
  });
  return new Blob([new Uint8Array([...header, ...body])], { type: "audio/midi" });
}

function varInt(value) {
  const bytes = [];
  let v = value;
  bytes.push(v & 0x7F);
  v >>= 7;
  while (v) {
    bytes.push((v & 0x7F) | 0x80);
    v >>= 7;
  }
  return bytes.reverse();
}

document.getElementById("play").onclick = () => { ensureCtx(); start(); };
document.getElementById("stop").onclick = stop;
document.getElementById("exportWav").onclick = exportWav;
document.getElementById("exportMid").onclick = exportMidi;
document.getElementById("copy").onclick = () => navigator.clipboard.writeText(punch());

["bpm","key","chords"].forEach(id => {
  document.getElementById(id).onchange = e => {
    if (id === "bpm") state.bpm = Math.max(60, Math.min(180, +e.target.value));
    if (id === "key") state.key = e.target.value;
    if (id === "chords") state.chords = e.target.value.split(/\s+/).slice(0,4);
    while (state.chords.length < 4) state.chords.push(state.chords[0] || "C");
    save(); render();
  };
});
["Piano","Guitar","Bass","Trumpet","Violin","Kit"].forEach(c => {
  const el = document.getElementById("gain"+c);
  if (el) el.oninput = e => {
    const k = c.toLowerCase();
    state.gains[k] = +e.target.value;
    if (chairGains[k]) chairGains[k].gain.value = state.gains[k];
    save();
  };
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stop();
});

loadState();
render();
document.getElementById("status").textContent = "Tap Play to start audio…";
document.body.addEventListener("click", async () => {
  ensureCtx();
  if (Object.keys(buffers).length === 0) await loadSamples();
}, { once: true });
