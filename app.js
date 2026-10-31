const CDN = "https://cdn.jsdelivr.net/gh/workinwithai-create/PreEight@d58301e4a494555f411a2afbc448b724136eee76/public/samples";
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const BARS = 4;
const STEPS_PER_BAR = 16;

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

function playSample(key, when, rate = 1, gain = 0.4, chair = "kit", duration = null) {
  const b = buffers[key];
  if (!b || !ctx) return null;
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.01);
  if (duration) {
    g.gain.setValueAtTime(gain, when + duration - 0.02);
    g.gain.linearRampToValueAtTime(0, when + duration);
  } else {
    g.gain.linearRampToValueAtTime(0, when + 0.4);
  }
  src.connect(g);
  g.connect(chairGains[chair] || master);
  src.start(when);
  if (duration) src.stop(when + duration + 0.05);
  activeSources.push(src);
  src.onended = () => { const i = activeSources.indexOf(src); if (i>=0) activeSources.splice(i,1); };
  return src;
}

function scheduleStep(step, time) {
  const bar = Math.floor(step / STEPS_PER_BAR) % BARS;
  const s = step % STEPS_PER_BAR;
  const off = keyOffset();
  const chord = parseChord(state.chords[bar] || "C", off);
  const rec = state.recipe.id;
  const stepDur = 60 / state.bpm / 4;

  if (s % 4 === 0) playSample("kick", time, 1, 0.7 * state.gains.kit, "kit");
  if (s === 8) playSample("snare", time, 1, 0.5 * state.gains.kit, "kit");
  if (s % 2 === 0) playSample("hat", time, 1, 0.15 * state.gains.kit, "kit");

  const isCall = bar % 2 === 0;
  if (rec === "piano-trumpet") {
    if (isCall && s === 0) {
      const p = closestSample("piano", chord[0]);
      if (p) playSample("piano-"+p.path, time, p.rate, 0.5 * state.gains.piano, "piano", stepDur*4);
    }
    if (!isCall && s === 0) {
      const t = closestSample("trumpet", chord[2] + 12);
      if (t) playSample("trumpet-"+t.path, time, t.rate, 0.45 * state.gains.trumpet, "trumpet", stepDur*8);
    }
  } else if (rec === "nylon-violin") {
    if (isCall && (s === 0 || s === 4 || s === 8 || s === 12)) {
      const g = closestSample("guitar", chord[Math.floor(s/4) % 3]);
      if (g) playSample("guitar-"+g.path, time, g.rate, 0.4 * state.gains.guitar, "guitar");
    }
    if (!isCall && s === 0) {
      const v = closestSample("violin", chord[1]);
      if (v) playSample("violin-"+v.path, time, v.rate, 0.4 * state.gains.violin, "violin", stepDur*16);
    }
  } else if (rec === "bass-answer") {
    if (isCall && s === 0) {
      const p = closestSample("piano", chord[0]);
      if (p) playSample("piano-"+p.path, time, p.rate, 0.35 * state.gains.piano, "piano");
    }
    if (!isCall && (s === 0 || s === 8)) {
      const b = closestSample("bass", chord[0] - 24);
      if (b) playSample("bass-"+b.path, time, b.rate, 0.5 * state.gains.bass, "bass");
    }
  } else if (rec === "kit-call") {
    if (isCall && s === 0) playSample("kick", time, 1, 0.8 * state.gains.kit, "kit");
    if (isCall && s === 8) playSample("snare", time, 1, 0.6 * state.gains.kit, "kit");
    if (!isCall && s === 0) {
      const t = closestSample("trumpet", chord[2]);
      if (t) playSample("trumpet-"+t.path, time, t.rate, 0.4 * state.gains.trumpet, "trumpet");
      const v = closestSample("violin", chord[1]);
      if (v) playSample("violin-"+v.path, time, v.rate, 0.35 * state.gains.violin, "violin");
    }
  } else {
    if (s === 0) {
      if (bar === 0) {
        const p = closestSample("piano", chord[0]);
        if (p) playSample("piano-"+p.path, time, p.rate, 0.45 * state.gains.piano, "piano");
      } else if (bar === 1) {
        const t = closestSample("trumpet", chord[2]);
        if (t) playSample("trumpet-"+t.path, time, t.rate, 0.4 * state.gains.trumpet, "trumpet");
      } else if (bar === 2) {
        const g = closestSample("guitar", chord[1]);
        if (g) playSample("guitar-"+g.path, time, g.rate, 0.4 * state.gains.guitar, "guitar");
      } else {
        const b = closestSample("bass", chord[0]-24);
        if (b) playSample("bass-"+b.path, time, b.rate, 0.5 * state.gains.bass, "bass");
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

async function exportWav() {
  ensureCtx();
  const sampleRate = 48000;
  const length = Math.round(BARS * 4 * 60 / state.bpm * sampleRate);
  alert("WAV export: " + length + " samples at " + state.bpm + " BPM. Full offline render with tail fold pending full implementation.");
}

function exportMidi() {
  alert("MIDI export: one track per chair, tempo and 4/4 set. Full SMF writer pending.");
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
