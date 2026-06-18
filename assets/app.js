// 12-lead ECG dashboard (UNO Q WebUI brick)
// Filter · calibrated mV grid + 1mV cal pulse · gain · sweep speed ·
// stacked / 3x4 / 3x4+rhythm layout · freeze · heart rate · lead-off ·
// EDF+ (default, raw) / CSV / PNG export · theme switcher.

const canvas = document.getElementById("ecg");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const rateEl = document.getElementById("rate");
const bpmEl = document.getElementById("bpm");
const filterCb = document.getElementById("filter");
const calibCb = document.getElementById("calib");
const calPulseCb = document.getElementById("calpulse");
const themeSel = document.getElementById("theme");
const layoutSel = document.getElementById("layout");
const gainSel = document.getElementById("gain");
const sweepSel = document.getElementById("sweep");
const freezeBtn = document.getElementById("freeze");
const csvBtn = document.getElementById("csv");
const edfBtn = document.getElementById("edf");
const capBtn = document.getElementById("capture");
const moreBtn = document.getElementById("more");
const moreMenu = document.getElementById("moreMenu");
const pngBtn = document.getElementById("png");
const trendsBtn = document.getElementById("trends");
const reportBtn = document.getElementById("report");
const leadoffEl = document.getElementById("leadoff");
const measEl = document.getElementById("measurements");
const saveBtn = document.getElementById("save");
const histBtn = document.getElementById("history");
const histModal = document.getElementById("histModal");
const histList = document.getElementById("histList");
const histClose = document.getElementById("histClose");
const histClear = document.getElementById("histClear");
const reviewEl = document.getElementById("review");
const VIEWER = !!window.ECG_VIEWER;   // archive viewer (no board): read-only, no live stream

const FS = 125;                  // Hz — must match the sketch (500 / DECIMATE)
let lsbUv = (2 * 2.4 / 6) / (1 << 24) * 1e6;
const BUFFER_SEC = 10;
const WINDOW = Math.round(FS * BUFFER_SEC);

const THEMES = {
  dark:  { bg:"#0e0f12", trace:"#4cc3a0", sep:"#23262d", label:"#cdd2d8", gMinor:"#16211b", gMajor:"#27392f" },
  white: { bg:"#ffffff", trace:"#0b7a4b", sep:"#d4d8de", label:"#444b54", gMinor:"#eef1f3", gMajor:"#d6dbe1" },
  paper: { bg:"#fff1f0", trace:"#1a1a1a", sep:"#f1c7c7", label:"#7a3030", gMinor:"#f9d6d6", gMajor:"#ec9d9d" },
};

// persisted settings
let theme = localStorage.getItem("ecgTheme") || "paper";
let layout = localStorage.getItem("ecgLayout") || "grid";   // 3×4 printout is the default
let mvRange = parseFloat(localStorage.getItem("ecgGain")) || 1.5;
let sweep = parseFloat(localStorage.getItem("ecgSweep")) || 25;
if (sweep !== 25 && sweep !== 50) sweep = 25;   // 12.5 mm/s removed (redundant with the 10 s buffer)
function applyTheme(t) { theme = THEMES[t] ? t : "paper"; document.body.className = "theme-" + theme; themeSel.value = theme; localStorage.setItem("ecgTheme", theme); }
themeSel.onchange = () => applyTheme(themeSel.value);
layoutSel.onchange = () => { layout = layoutSel.value; localStorage.setItem("ecgLayout", layout); };
gainSel.onchange = () => { mvRange = parseFloat(gainSel.value); localStorage.setItem("ecgGain", mvRange); };
sweepSel.onchange = () => { sweep = parseFloat(sweepSel.value); localStorage.setItem("ecgSweep", sweep); };
applyTheme(theme); layoutSel.value = layout; gainSel.value = String(mvRange); sweepSel.value = String(sweep);

// "⚙ More" popover (secondary controls)
moreBtn.onclick = (e) => { e.stopPropagation(); moreMenu.hidden = !moreMenu.hidden; };
document.addEventListener("click", (e) => { if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== moreBtn) moreMenu.hidden = true; });

// freeze
let frozen = false, frozenBuf = null;
freezeBtn.onclick = () => {
  frozen = !frozen;
  frozenBuf = frozen ? buf.slice() : null;
  freezeBtn.classList.toggle("on", frozen);
  freezeBtn.textContent = frozen ? "▶" : "❄";
};

// trends overlay + printable report
let trendsOn = false;
const trendBuf = [];   // {t, hr} sampled once/sec
trendsBtn.onclick = () => { trendsOn = !trendsOn; trendsBtn.classList.toggle("on", trendsOn); };
reportBtn.onclick = () => window.print();

// Channel -> lead mapping (Table 3.1). c[0..7] = CH1..CH8.
const I = c => c[1], II = c => c[2];
const LEADS = [
  { name: "I", fn: I }, { name: "II", fn: II }, { name: "III", fn: c => II(c) - I(c) },
  { name: "aVR", fn: c => -(I(c) + II(c)) / 2 }, { name: "aVL", fn: c => I(c) - II(c) / 2 },
  { name: "aVF", fn: c => II(c) - I(c) / 2 },
  { name: "V1", fn: c => c[7] }, { name: "V2", fn: c => c[3] }, { name: "V3", fn: c => c[4] },
  { name: "V4", fn: c => c[5] }, { name: "V5", fn: c => c[6] }, { name: "V6", fn: c => c[0] },
];

// Lead-off — SOFTWARE detection. The ADS1298 hardware comparators don't trip with
// this front-end (the WCT/RLD bias holds the input pins mid-rail even when an
// electrode is open), so we detect a disconnected channel from the signal itself:
// it saturates to full-scale and/or swings far beyond any physiological ECG.
const CHLEAD = ["V6", "I", "II", "V2", "V3", "V4", "V5", "V1"];   // ch0..ch7 measured lead
function setLeadoff(off) {
  if (off.length === 0) { leadoffEl.textContent = "● leads OK"; leadoffEl.className = "leadoff ok"; }
  else { leadoffEl.textContent = "● leads off"; leadoffEl.className = "leadoff err"; }
}
const satHold = new Array(8).fill(-1e9);                 // last sample-time each channel railed
function checkLeadoff() {
  const n = buf.length;
  if (n < FS) return;
  const SAT = 0.95 * 8388608;     // raw full-scale rail
  const BIG = 300000;             // raw swing far beyond ECG (~14 mV)
  const FLAT = 2500;              // filtered swing so small there's no cardiac signal (~0.12 mV)
  const start = Math.max(0, n - FS * 2);                 // last ~2 s
  const rlo = new Array(8).fill(Infinity), rhi = new Array(8).fill(-Infinity);
  const flo = new Array(8).fill(Infinity), fhi = new Array(8).fill(-Infinity);
  for (let i = start; i < n; i++) {
    const r = buf[i].raw, f = buf[i].f;
    for (let c = 0; c < 8; c++) {
      if (Math.abs(r[c]) >= SAT) satHold[c] = buf[i].t;  // sticky ~5 s (railing is intermittent)
      if (r[c] < rlo[c]) rlo[c] = r[c]; if (r[c] > rhi[c]) rhi[c] = r[c];
      if (f[c] < flo[c]) flo[c] = f[c]; if (f[c] > fhi[c]) fhi[c] = f[c];
    }
  }
  let off = [];
  for (let c = 0; c < 8; c++) {
    const railed = (lastT - satHold[c]) < 5;
    const big = (rhi[c] - rlo[c]) > BIG;
    const flat = (fhi[c] - flo[c]) < FLAT;               // no cardiac signal at all
    if (railed || big || flat) off.push(CHLEAD[c]);
  }
  setLeadoff(off);   // binary: any flagged channel ⇒ "leads off"
}
setInterval(checkLeadoff, 1000);

// ---------- biquad band-pass (RBJ), 0.5–40 Hz ----------
function coef(type, f0, fs, Q) {
  const w = 2 * Math.PI * f0 / fs, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === "lp") { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
const mk = () => ({ x1: 0, x2: 0, y1: 0, y2: 0 });
function flt(co, s, x) { const y = co.b0 * x + co.b1 * s.x1 + co.b2 * s.x2 - co.a1 * s.y1 - co.a2 * s.y2; s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y; return y; }
const lp = coef("lp", 40, FS, 0.707), hp = coef("hp", 0.5, FS, 0.707);
const lpS = Array.from({ length: 8 }, mk), hpS = Array.from({ length: 8 }, mk);
function filterCh(raw) { const o = new Array(8); for (let i = 0; i < 8; i++) o[i] = flt(lp, lpS[i], flt(hp, hpS[i], raw[i])); return o; }

// ---------- data ----------
const buf = [];
let lastT = 0;
let reviewing = false;            // true while a stored study is loaded (ignore live data)
let currentStudyMeta = null;      // {patient, created} of the loaded study (for EDF+ header), else null
function push(t, raw) {
  if (reviewing) return;          // viewing a saved study — don't overwrite it with live samples
  const f = filterCh(raw);
  buf.push({ t, raw, f });
  while (buf.length > WINDOW) buf.shift();
  lastT = t;
  detectHR(II(f), t);
  if (recording) rec.push({ t, raw, f });
}

// ---------- heart rate (filtered lead II) ----------
let env = 1, lastPeak = 0, prevV = 0, bpmHist = [];
function detectHR(v, t) {
  env = Math.max(Math.abs(v), env * 0.995);
  const thr = 0.4 * env;
  if (prevV <= thr && v > thr && (t - lastPeak) > 0.3) {
    if (lastPeak > 0) { const rr = t - lastPeak; if (rr > 0.3 && rr < 2) { bpmHist.push(60 / rr); if (bpmHist.length > 6) bpmHist.shift(); } }
    lastPeak = t;
  }
  prevV = v;
}
function bpmNow() { if (!bpmHist.length || (lastT - lastPeak) > 3) return null; const s = [...bpmHist].sort((a, b) => a - b); return Math.round(s[s.length >> 1]); }

// ---------- recording / export ----------
let recording = false, capturing = false;
const rec = [];
pngBtn.onclick = () => { const a = document.createElement("a"); a.download = "ecg_" + Date.now() + ".png"; a.href = canvas.toDataURL("image/png"); a.click(); };
csvBtn.onclick = () => {
  const src = rec.length ? rec : buf;
  const head = ["t_s", ...LEADS.map(l => l.name + "_mV"), ...LEADS.map(l => l.name + "_filt_mV")].join(",");
  const lines = [head];
  for (const s of src) {
    const raw = LEADS.map(l => (l.fn(s.raw) * lsbUv / 1000).toFixed(4));
    const fil = LEADS.map(l => (l.fn(s.f) * lsbUv / 1000).toFixed(4));
    lines.push([s.t.toFixed(3), ...raw, ...fil].join(","));
  }
  const a = document.createElement("a"); a.download = "ecg_" + Date.now() + ".csv";
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })); a.click();
};

// ---------- EDF+ export (raw 12-lead in µV — DEFAULT raw format, ML-ready) ----------
// Standard biosignal container: self-describing header (sampling rate, µV calibration,
// per-lead labels, patient, start time) + an EDF+ annotation channel; int16 samples.
// Readable directly by pyEDFlib / MNE and comparable to public ECG datasets.
function _edfField(s, n) { s = String(s); if (s.length > n) s = s.slice(0, n); while (s.length < n) s += " "; return s; }

function buildEDF(src) {
  const fs = FS, ns = LEADS.length, N = src.length, spr = fs;          // 1-second data records
  const nrec = Math.max(1, Math.ceil(N / spr)), ANN = 128, annSpr = ANN / 2;
  const leads = [], pmin = [], pmax = [];
  for (let c = 0; c < ns; c++) {                                       // raw (unfiltered) µV per lead + phys range
    const a = new Float64Array(N); let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i++) { const v = LEADS[c].fn(src[i].raw) * lsbUv; a[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!isFinite(lo)) { lo = -1000; hi = 1000; }
    lo = Math.floor(lo); hi = Math.ceil(hi); if (hi - lo < 100) { lo -= 50; hi += 50; }   // EDF requires pmin<pmax
    leads.push(a); pmin.push(lo); pmax.push(hi);
  }
  const sig = ns + 1, headerLen = 256 * (sig + 1);
  const d = (currentStudyMeta && currentStudyMeta.created) ? new Date(currentStudyMeta.created * 1000) : new Date();
  const p = x => String(x).padStart(2, "0");
  const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const pid = (((currentStudyMeta && currentStudyMeta.patient) || "X").replace(/\s+/g, "_")) || "X";

  let h = "";
  h += _edfField("0", 8);                                             // version
  h += _edfField(pid + " X X X", 80);                                // EDF+ local patient id
  h += _edfField(`Startdate ${p(d.getDate())}-${MON[d.getMonth()]}-${d.getFullYear()} X UNOQ-ECG raw_12lead_${fs}Hz`, 80);
  h += _edfField(`${p(d.getDate())}.${p(d.getMonth() + 1)}.${p(d.getFullYear() % 100)}`, 8);  // startdate dd.mm.yy
  h += _edfField(`${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`, 8);          // starttime hh.mm.ss
  h += _edfField(String(headerLen), 8);
  h += _edfField("EDF+C", 44);                                        // reserved → EDF+ continuous
  h += _edfField(String(nrec), 8);
  h += _edfField("1", 8);                                             // data-record duration (s)
  h += _edfField(String(sig), 4);

  const lbl = LEADS.map(l => "ECG " + l.name).concat(["EDF Annotations"]);
  const cols = [[], [], [], [], [], [], [], [], [], []];              // field-major signal header
  for (let c = 0; c < sig; c++) {
    const ann = c === ns;
    cols[0].push(_edfField(lbl[c], 16));                              // label
    cols[1].push(_edfField("", 80));                                 // transducer
    cols[2].push(_edfField(ann ? "" : "uV", 8));                     // physical dimension
    cols[3].push(_edfField(ann ? "-1" : String(pmin[c]), 8));        // physical min
    cols[4].push(_edfField(ann ? "1" : String(pmax[c]), 8));         // physical max
    cols[5].push(_edfField("-32768", 8));                           // digital min
    cols[6].push(_edfField("32767", 8));                            // digital max
    cols[7].push(_edfField("", 80));                                 // prefiltering
    cols[8].push(_edfField(String(ann ? annSpr : spr), 8));          // samples per record
    cols[9].push(_edfField("", 32));                                 // reserved
  }
  h += cols.map(col => col.join("")).join("");

  const recBytes = ns * spr * 2 + ANN, out = new Uint8Array(headerLen + nrec * recBytes);
  for (let i = 0; i < headerLen; i++) out[i] = h.charCodeAt(i) & 0xff;
  const dv = new DataView(out.buffer);
  let off = headerLen;
  for (let r = 0; r < nrec; r++) {
    for (let c = 0; c < ns; c++) {
      const a = leads[c], lo = pmin[c], span = pmax[c] - pmin[c];
      for (let k = 0; k < spr; k++) {
        const i = r * spr + k, v = i < N ? a[i] : a[N - 1];           // pad final record by repeating last sample
        let q = Math.round((v - lo) / span * 65535 - 32768);
        q = q < -32768 ? -32768 : (q > 32767 ? 32767 : q);
        dv.setInt16(off, q, true); off += 2;
      }
    }
    let tal = `+${r}\x14\x14\x00`;                                    // time-keeping TAL (required each record)
    if (r === 0) tal += `+0\x14${pid} | raw 12-lead @ ${fs} Hz\x14\x00`;
    for (let b = 0; b < ANN; b++) out[off + b] = b < tal.length ? (tal.charCodeAt(b) & 0xff) : 0;
    off += ANN;
  }
  return out;
}

edfBtn.onclick = () => {
  const src = rec.length ? rec : buf;
  if (!src.length) return;
  const name = (currentStudyMeta && currentStudyMeta.patient) ? currentStudyMeta.patient.replace(/\s+/g, "_") : "live";
  const a = document.createElement("a");
  a.download = `ecg_${name}_${Date.now()}.edf`;
  a.href = URL.createObjectURL(new Blob([buildEDF(src)], { type: "application/octet-stream" }));
  a.click();
};

// On-demand fixed-length capture (Omron-style spot recording) → local EDF+.
const CAPTURE_SEC = 30;
capBtn.onclick = () => {
  if (capturing || reviewing) return;
  capturing = true; rec.length = 0; recording = true;
  capBtn.classList.add("on");
  let left = CAPTURE_SEC; capBtn.textContent = `● ${left}s`;
  const iv = setInterval(() => { if (--left > 0) capBtn.textContent = `● ${left}s`; }, 1000);
  setTimeout(() => {
    clearInterval(iv);
    recording = false; capturing = false;
    capBtn.classList.remove("on"); capBtn.textContent = "Capture 30s";
    if (rec.length) {
      const a = document.createElement("a");
      a.download = `ecg_capture_${Date.now()}.edf`;
      a.href = URL.createObjectURL(new Blob([buildEDF(rec)], { type: "application/octet-stream" }));
      a.click();
    }
  }, CAPTURE_SEC * 1000);
};

// ---------- save study / history (MongoDB Atlas, via the server) ----------
// "Save" tells the server to snapshot its current ~10 s buffer into the cloud DB.
// "History" lists saved studies; clicking one replays it here (review mode).
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

saveBtn.onclick = async () => {
  const p = prompt("Patient ID / name for this study:", "");
  if (p === null) return;                                   // cancelled
  const old = saveBtn.textContent; saveBtn.disabled = true; saveBtn.textContent = "Saving…";
  try {
    const r = await fetch("/save/" + encodeURIComponent(p.trim() || "anon")).then(r => r.json());
    saveBtn.textContent = (r && r.ok) ? "Saved ✓" : "DB off";
  } catch { saveBtn.textContent = "Error"; }
  setTimeout(() => { saveBtn.disabled = reviewing; saveBtn.textContent = old; }, 1600);
};

async function loadHistory() {
  histList.innerHTML = '<div class="hist-empty">Loading…</div>';
  try {
    const studies = await fetch("/studies").then(r => r.json());
    if (!Array.isArray(studies) || !studies.length) {
      histList.innerHTML = '<div class="hist-empty">No saved studies (or database not configured).</div>'; return;
    }
    histList.innerHTML = "";
    for (const s of studies) {
      const row = document.createElement("div");
      row.className = "hist-row";
      const when = new Date((s.created || 0) * 1000).toLocaleString();
      const dur = ((s.n_samples || 0) / (s.fs || FS)).toFixed(1);
      row.innerHTML = `<span class="pid">${escapeHtml(s.patient || "anon")}</span>` +
                      `<span class="sub">${when}</span><span class="dur">${dur}s</span>` +
                      (VIEWER ? "" : `<button class="btn hist-del" title="Delete this study">✕</button>`);
      row.onclick = () => openStudy(s.id);
      if (!VIEWER) row.querySelector(".hist-del").onclick = (e) => { e.stopPropagation(); deleteStudy(s.id); };
      histList.appendChild(row);
    }
  } catch { histList.innerHTML = '<div class="hist-empty">Failed to load (database not reachable).</div>'; }
}

async function deleteStudy(id) {
  if (!confirm("Delete this study?")) return;
  try { await fetch("/delete/" + encodeURIComponent(id)); } catch {}
  loadHistory();
}

histBtn.onclick = () => { histModal.hidden = false; loadHistory(); };
histClear.onclick = async () => {
  if (!confirm("Delete ALL saved studies? This cannot be undone.")) return;
  try { await fetch("/clear_studies"); } catch {}
  loadHistory();
};
histClose.onclick = () => { histModal.hidden = true; };
histModal.onclick = (e) => { if (e.target === histModal) histModal.hidden = true; };   // backdrop closes

// Run a stored study's raw rows through a fresh band-pass (independent of the live filter state).
function filterStudy(rows) {
  const lp2 = Array.from({ length: 8 }, mk), hp2 = Array.from({ length: 8 }, mk);
  if (rows.length) {                              // warm up the cold filters at the first sample's DC level
    const r0 = rows[0];                           // (else the 0.5 Hz high-pass settling shows as a big swoop in col 1: I/II/III)
    for (let w = 0; w < 300; w++)
      for (let c = 0; c < 8; c++) flt(lp, lp2[c], flt(hp, hp2[c], r0[c]));
  }
  return rows.map((raw, i) => {
    const f = new Array(8);
    for (let c = 0; c < 8; c++) f[c] = flt(lp, lp2[c], flt(hp, hp2[c], raw[c]));
    return { t: i / FS, raw, f };
  });
}

async function openStudy(id) {
  try {
    const st = await fetch("/study/" + encodeURIComponent(id)).then(r => r.json());
    if (!st || st.error || !Array.isArray(st.samples)) return;
    loadStudy(st);
    histModal.hidden = true;
  } catch {}
}

function loadStudy(st) {
  reviewing = true;
  currentStudyMeta = { patient: st.patient || "anon", created: st.created || (Date.now() / 1000) };
  saveBtn.disabled = true;                         // saving snapshots LIVE data, not the study
  if (st.lsb_uv) lsbUv = st.lsb_uv;
  frozen = false; frozenBuf = null;                // review shows buf directly
  freezeBtn.classList.remove("on"); freezeBtn.textContent = "❄";
  buf.length = 0;
  for (const s of filterStudy(st.samples)) buf.push(s);
  bpmHist = []; lastPeak = 0; prevV = 0; env = 1;  // recompute HR/measurements over the study
  for (const s of buf) detectHR(s.f[2], s.t);
  lastT = buf.length ? buf[buf.length - 1].t : 0;
  const when = st.created ? new Date(st.created * 1000).toLocaleString() : "";
  reviewEl.hidden = false;
  reviewEl.textContent = (VIEWER ? "✕ close · " : "◀ Live · reviewing ") + `${st.patient || "anon"}${when ? " · " + when : ""}`;
  computeMeasurements();
}

reviewEl.onclick = () => {                          // exit review → back to live
  reviewing = false; saveBtn.disabled = false; currentStudyMeta = null;
  buf.length = 0; lastT = 0;
  bpmHist = []; lastPeak = 0; prevV = 0; env = 1;
  reviewEl.hidden = true;
};

// ---------- rendering ----------
function resize() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, r.width * dpr); canvas.height = Math.max(1, r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 250));

let activeBuf = buf;

function drawLead(lead, x0, y0, w, h, windowSec, th, cal, useF, boxed, endIdx) {
  const labelW = boxed ? 30 : 52;
  const calW = (cal && calPulseCb.checked) ? 26 : 0;
  const xData = x0 + labelW + calW;
  const wData = x0 + w - xData;
  const yc = y0 + h / 2;
  const pxPerS = wData / windowSec;
  const pxPerMv = (h / 2) / mvRange;
  const nShow = Math.min(WINDOW, Math.round(FS * windowSec));

  if (cal) {
    ctx.strokeStyle = th.gMinor; ctx.lineWidth = 1; ctx.beginPath();
    if (0.04 * pxPerS >= 4) for (let s = 0; s <= windowSec + 1e-6; s += 0.04) { const x = xData + s * pxPerS; ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); }
    if (0.1 * pxPerMv >= 4) for (let mv = -mvRange; mv <= mvRange + 1e-6; mv += 0.1) { const y = yc - mv * pxPerMv; if (y >= y0 && y <= y0 + h) { ctx.moveTo(x0 + labelW, y); ctx.lineTo(x0 + w, y); } }
    ctx.stroke();
    ctx.strokeStyle = th.gMajor; ctx.beginPath();
    for (let s = 0; s <= windowSec + 1e-6; s += 0.2) { const x = xData + s * pxPerS; ctx.moveTo(x, y0); ctx.lineTo(x, y0 + h); }
    for (let mv = -mvRange; mv <= mvRange + 1e-6; mv += 0.5) { const y = yc - mv * pxPerMv; if (y >= y0 && y <= y0 + h) { ctx.moveTo(x0 + labelW, y); ctx.lineTo(x0 + w, y); } }
    ctx.stroke();
  }

  ctx.strokeStyle = th.sep; ctx.lineWidth = 1;
  if (boxed) ctx.strokeRect(x0, y0, w, h);
  else { ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(w, y0); ctx.stroke(); }

  // scaling
  const end = (endIdx == null) ? activeBuf.length : Math.min(activeBuf.length, Math.max(0, endIdx));
  const start = Math.max(0, end - nShow), n = end - start;
  let toY;
  if (cal) {
    let mean = 0; for (let i = start; i < end; i++) mean += lead.fn(useF ? activeBuf[i].f : activeBuf[i].raw); mean /= (n || 1);
    toY = v => yc - ((v - mean) * lsbUv / 1000) * pxPerMv;
  } else {
    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < end; i++) { const v = lead.fn(useF ? activeBuf[i].f : activeBuf[i].raw); if (v < lo) lo = v; if (v > hi) hi = v; }
    if (!isFinite(lo)) { lo = -1; hi = 1; } if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    toY = v => y0 + h - ((v - lo) / (hi - lo)) * h;
  }

  // 1 mV calibration pulse (in the reserved gutter, baseline at lane centre)
  if (cal && calW > 0) {
    ctx.strokeStyle = th.trace; ctx.lineWidth = 1.1; ctx.beginPath();
    const xa = x0 + labelW, top = yc - pxPerMv;
    ctx.moveTo(xa, yc); ctx.lineTo(xa + 5, yc);
    ctx.lineTo(xa + 5, top); ctx.lineTo(xData - 5, top);
    ctx.lineTo(xData - 5, yc); ctx.lineTo(xData, yc);
    ctx.stroke();
  }

  // label
  ctx.fillStyle = th.label; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(lead.name, x0 + 5, y0 + 3);

  // trace (newest at right edge)
  const stepPx = nShow > 1 ? wData / (nShow - 1) : 0;
  ctx.strokeStyle = th.trace; ctx.lineWidth = 1.1; ctx.beginPath();
  for (let j = 0; j < n; j++) {
    const i = start + j;
    const x = (x0 + w) - (n - 1 - j) * stepPx;
    const y = toY(lead.fn(useF ? activeBuf[i].f : activeBuf[i].raw));
    if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawTrend(W, H, th) {
  const tw = 240, thh = 90, tx = W - tw - 12, ty = H - thh - 12;
  ctx.fillStyle = theme === "dark" ? "rgba(15,17,22,0.88)" : "rgba(255,255,255,0.9)";
  ctx.fillRect(tx, ty, tw, thh);
  ctx.strokeStyle = th.sep; ctx.lineWidth = 1; ctx.strokeRect(tx, ty, tw, thh);
  const N = Math.min(trendBuf.length, 180), start = trendBuf.length - N;
  let lo = Infinity, hi = -Infinity;
  for (let i = start; i < trendBuf.length; i++) { const v = trendBuf[i].hr; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) return;
  lo = Math.min(lo, hi - 10) - 5; hi += 5;
  ctx.fillStyle = th.label; ctx.font = "10px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(`HR trend · ${trendBuf[trendBuf.length - 1].hr} bpm`, tx + 6, ty + 4);
  ctx.fillText(hi.toFixed(0), tx + 4, ty + 18); ctx.fillText(lo.toFixed(0), tx + 4, ty + thh - 14);
  const px0 = tx + 26, pw = tw - 34, py0 = ty + 20, ph = thh - 32;
  ctx.strokeStyle = th.trace; ctx.lineWidth = 1.2; ctx.beginPath();
  for (let i = start; i < trendBuf.length; i++) {
    const j = i - start, x = px0 + (N > 1 ? j / (N - 1) : 0) * pw, y = py0 + ph - ((trendBuf[i].hr - lo) / (hi - lo)) * ph;
    if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function draw() {
  const th = THEMES[theme];
  const dpr = window.devicePixelRatio || 1, W = canvas.width / dpr, H = canvas.height / dpr;
  activeBuf = (frozen && frozenBuf) ? frozenBuf : buf;
  ctx.fillStyle = th.bg; ctx.fillRect(0, 0, W, H);
  const cal = calibCb.checked, useF = filterCb.checked;
  const k = 25 / sweep;                                  // sweep-speed time scale
  const cap = s => Math.min(s, BUFFER_SEC);
  let shownSec = BUFFER_SEC;                              // visible duration (for the scale caption)

  if (layout === "stacked") {
    const laneH = H / LEADS.length, ws = cap(10 * k);     // 10 s/lane at 25 mm/s (5 s at 50)
    shownSec = ws;
    for (let i = 0; i < LEADS.length; i++) drawLead(LEADS[i], 0, i * laneH, W, laneH, ws, th, cal, useF, false);
  } else {
    // Clinical 3×4 printout: the four columns are sequential time-slices of one
    // ~10 s acquisition (col 1 = 0–2.5 s … col 4 = 7.5–10 s), tiling the full page.
    const rhythm = layout === "grid_rhythm";
    const gridH = rhythm ? H * 0.78 : H;
    const cols = 4, rows = 3, cw = W / cols, ch = gridH / rows;
    const pageEnd = activeBuf.length;
    const segLen = Math.max(1, Math.floor(Math.min(activeBuf.length, Math.round(FS * cap(10 * k))) / cols));
    const ws = segLen / FS;                                // seconds per column (≈2.5 s at 25 mm/s)
    shownSec = ws * cols;                                  // full page duration (~10 s at 25 mm/s)
    for (let idx = 0; idx < LEADS.length; idx++) {
      const c = Math.floor(idx / rows), r = idx % rows;
      const endIdx = pageEnd - (cols - 1 - c) * segLen;    // column c → its 2.5 s slice of the 10 s page
      drawLead(LEADS[idx], c * cw, r * ch, cw, ch, ws, th, cal, useF, true, endIdx);
    }
    if (rhythm) drawLead(LEADS[1], 0, gridH, W, H - gridH, cap(BUFFER_SEC * k), th, cal, useF, false);  // full 10 s lead-II rhythm strip
  }

  // ECG scale/speed caption (printout-style footer)
  const capTxt = `${sweep} mm/s · 10 mm/mV · ${Math.round(shownSec)} s`;
  ctx.font = "10px sans-serif"; const capW = ctx.measureText(capTxt).width;
  ctx.fillStyle = theme === "dark" ? "rgba(15,17,22,0.72)" : "rgba(255,255,255,0.72)";
  ctx.fillRect(W - capW - 14, H - 19, capW + 12, 16);
  ctx.fillStyle = th.label; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
  ctx.fillText(capTxt, W - 7, H - 5);

  if (trendsOn && trendBuf.length > 1) drawTrend(W, H, th);

  const b = bpmNow();
  bpmEl.textContent = b ? b + " BPM" : "– BPM";
  requestAnimationFrame(draw);
}

// rate counter
let rxThisSec = 0, lastSec = performance.now();
setInterval(() => { if (VIEWER) return; const now = performance.now(), dt = (now - lastSec) / 1000; if (dt >= 1) { rateEl.textContent = `${Math.round(rxThisSec / dt)} /s`; rxThisSec = 0; lastSec = now; } }, 500);

// ---------- measurements: PR / QRS / QT / QTc, axis, ST — APPROXIMATE, non-diagnostic ----------
function median(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function axisCat(a) { if (a >= -30 && a <= 90) return "normal"; if (a < -30 && a >= -90) return "LAD"; if (a > 90 && a <= 180) return "RAD"; return "extreme"; }

function computeMeasurements() {
  const b = buf, n = b.length;
  if (n < FS * 2.5) return;
  const II = i => b[i].f[2], LI = i => b[i].f[1], AVF = i => b[i].f[2] - b[i].f[1] / 2;
  const dt = 1 / FS, w = s => Math.round(s * FS);

  // R peaks on filtered lead II
  let maxA = 0; for (let i = 0; i < n; i++) { const v = Math.abs(II(i)); if (v > maxA) maxA = v; }
  if (maxA < 1) return;
  const thr = 0.5 * maxA, refr = w(0.3), peaks = []; let last = -1e9;
  for (let i = 2; i < n - 2; i++) if (II(i) > thr && II(i) >= II(i - 1) && II(i) > II(i + 1) && (i - last) > refr) { peaks.push(i); last = i; }
  if (peaks.length < 3) return;

  const PR = [], QRS = [], QT = [], QTc = [], ST = [], ANG = [];
  for (let k = 1; k < peaks.length - 1; k++) {
    const r = peaks[k], rr = (peaks[k] - peaks[k - 1]) * dt;
    const b0 = Math.max(0, r - w(0.12)), b1 = Math.max(1, r - w(0.06));
    const ba = []; for (let i = b0; i < b1; i++) ba.push(II(i)); const bl = median(ba);     // isoelectric baseline (PR segment)
    const Ramp = Math.abs(II(r) - bl); if (Ramp < 1) continue;
    const aThr = 0.1 * Ramp;

    let q = r; for (let i = r; i > r - w(0.12) && i > 0; i--) if (Math.abs(II(i) - bl) < aThr) { q = i; break; }   // QRS onset
    let j = r; for (let i = r; i < r + w(0.16) && i < n; i++) if (Math.abs(II(i) - bl) < aThr) { j = i; break; }   // QRS offset (J point)
    QRS.push((j - q) * dt * 1000);

    // P wave (bump before QRS)
    let pPk = -1, pMax = -Infinity;
    for (let i = Math.max(1, q - w(0.25)); i < q - w(0.04); i++) { const v = II(i) - bl; if (v > pMax) { pMax = v; pPk = i; } }
    if (pPk > 0 && pMax > 0.08 * Ramp) { let pOn = pPk; for (let i = pPk; i > pPk - w(0.12) && i > 0; i--) if ((II(i) - bl) < 0.15 * pMax) { pOn = i; break; } PR.push((q - pOn) * dt * 1000); }

    // T wave + end (baseline return)
    let tPk = -1, tMax = -Infinity;
    for (let i = j + w(0.04); i < Math.min(n, j + w(0.42)); i++) { const v = Math.abs(II(i) - bl); if (v > tMax) { tMax = v; tPk = i; } }
    if (tPk > 0) { let tEnd = tPk; for (let i = tPk; i < Math.min(n, tPk + w(0.22)); i++) if (Math.abs(II(i) - bl) < 0.1 * tMax) { tEnd = i; break; } const qt = (tEnd - q) * dt; QT.push(qt * 1000); if (rr > 0) QTc.push(qt / Math.sqrt(rr) * 1000); }

    ST.push((II(Math.min(n - 1, j + w(0.06))) - bl) * lsbUv / 1000);   // ST at J+60ms

    // frontal-plane QRS axis from net area in I and aVF
    const bIa = [], bAa = []; for (let i = b0; i < b1; i++) { bIa.push(LI(i)); bAa.push(AVF(i)); }
    const blI = median(bIa), blA = median(bAa); let nI = 0, nA = 0;
    for (let i = q; i <= j; i++) { nI += LI(i) - blI; nA += AVF(i) - blA; }
    ANG.push(Math.atan2(nA, nI) * 180 / Math.PI);
  }

  // rhythm classification (non-diagnostic) + HR trend sample
  const RR = []; for (let k = 1; k < peaks.length; k++) RR.push((peaks[k] - peaks[k - 1]) / FS);
  let rhythm = "—";
  if (RR.length >= 3) {
    const mRR = RR.reduce((a, b) => a + b, 0) / RR.length, hrr = 60 / mRR;
    const sd = Math.sqrt(RR.reduce((a, b) => a + (b - mRR) ** 2, 0) / RR.length);
    if (sd / mRR > 0.15) rhythm = "Irregular (?AF)";
    else if (hrr < 60) rhythm = "Sinus brady";
    else if (hrr > 100) rhythm = "Sinus tachy";
    else rhythm = "Normal sinus";
  }
  const hrT = bpmNow();
  if (hrT) { trendBuf.push({ t: Date.now(), hr: hrT }); if (trendBuf.length > 600) trendBuf.shift(); }

  const ms = v => isFinite(v) ? v.toFixed(0) + " ms" : "—";
  const pr = median(PR), qrs = median(QRS), qt = median(QT), qtc = median(QTc), st = median(ST), ang = median(ANG);
  measEl.innerHTML =
    `<span>Rhythm<b>${rhythm}</b></span>` +
    `<span>PR<b>${ms(pr)}</b></span>` +
    `<span>QRS<b>${ms(qrs)}</b></span>` +
    `<span>QT<b>${ms(qt)}</b></span>` +
    `<span>QTc<b>${ms(qtc)}</b></span>` +
    `<span>Axis<b>${isFinite(ang) ? (ang > 0 ? "+" : "") + ang.toFixed(0) + "° " + axisCat(ang) : "—"}</b></span>` +
    `<span>ST(II)<b>${isFinite(st) ? (st > 0 ? "+" : "") + st.toFixed(2) + " mV" : "—"}</b></span>` +
    `<span class="note">approx · not for clinical use</span>`;
}
setInterval(computeMeasurements, 1000);

// init
resize();
fetch("/meta").then(r => r.json()).then(m => { if (m && m.lsb_uv) lsbUv = m.lsb_uv; metaEl.textContent = `12-lead · ${lsbUv.toFixed(3)} µV/LSB`; }).catch(() => {});
if (VIEWER) {
  // Archive viewer: no board, no live stream — read-only browse + replay of stored studies.
  document.title = "ECG archive";
  statusEl.textContent = "archive"; statusEl.className = "";
  rateEl.textContent = "";
  for (const el of [saveBtn, histClear, capBtn]) if (el) el.style.display = "none";
  histBtn.click();                                 // open the studies list immediately
} else {
  fetch("/samples").then(r => r.json()).then(list => { if (Array.isArray(list)) list.forEach(s => push(s.t, s.ch)); }).catch(() => {});
  const socket = io(window.location.origin, { path: "/socket.io", transports: ["polling", "websocket"], autoConnect: true });
  socket.on("ecg", (s) => { push(s.t, s.ch); rxThisSec++; });
  socket.on("connect", () => { statusEl.textContent = "live"; statusEl.className = "ok"; });
  socket.on("disconnect", () => { statusEl.textContent = "disconnected"; statusEl.className = "err"; });
  socket.on("connect_error", () => { statusEl.textContent = "error"; statusEl.className = "err"; });
}

requestAnimationFrame(draw);
