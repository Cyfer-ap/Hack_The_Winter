// ---------- CONFIG ----------
const DATA_URL = "./data.json";

// refresh rates
const POLL_NORMAL_MS = 6000;
const POLL_VSAT_MS = 20000;

// OSM tiles
const OSM_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

// local storage keys
const KEY_PAYLOAD = "lews_payload";
const KEY_ACK_AT = "lews_ack_at";
const KEY_MUTED = "lews_muted";
const KEY_VSAT = "lews_vsat";
const KEY_BLACKOUT = "lews_blackout";
const KEY_SIM_DECISION = "lews_sim_decision"; // "YES"/"NO"/null

// cache names from service worker
const TILE_CACHE_NAME = "lews-tiles-v1";

// ---------- STATE ----------
let map, baseTileLayer;
let gridLayer;
let zonesLayer;

let lastPayload = null;

let pollTimer = null;
let alarmInterval = null;

let playback = { enabled: false, t: null, decision: null, confidence: null };
let autoplayTimer = null;
let autoplayIdx = 0;

// ---------- HELPERS ----------
function log(msg) {
  const el = document.getElementById("log");
  const ts = new Date().toLocaleTimeString();
  el.innerHTML = `[${ts}] ${msg}\n` + el.innerHTML;
}

function setConn(ok, labelOverride = null) {
  const dot = document.getElementById("connDot");
  const text = document.getElementById("connText");
  dot.className = "dot " + (ok ? "green" : "red");
  text.textContent = labelOverride || (ok ? "LOCAL DATA OK" : "OFFLINE (CACHE)");
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function isYES(x) { return String(x || "NO").toUpperCase() === "YES"; }

function getMuted() { return localStorage.getItem(KEY_MUTED) === "1"; }
function setMuted(v) { localStorage.setItem(KEY_MUTED, v ? "1" : "0"); updateAlarmText(); }

function getAckAt() { return localStorage.getItem(KEY_ACK_AT); }
function setAckNow() {
  localStorage.setItem(KEY_ACK_AT, new Date().toISOString());
  updateAckText();
}
function clearAck() {
  localStorage.removeItem(KEY_ACK_AT);
  updateAckText();
}

function getVSAT() { return localStorage.getItem(KEY_VSAT) === "1"; }
function setVSAT(v) { localStorage.setItem(KEY_VSAT, v ? "1" : "0"); updateVSATButton(); restartPolling(); }

function getBlackout() { return localStorage.getItem(KEY_BLACKOUT) === "1"; }
function setBlackout(v) {
  localStorage.setItem(KEY_BLACKOUT, v ? "1" : "0");
  updateBlackoutButton();
}

function getSimDecision() {
  const v = localStorage.getItem(KEY_SIM_DECISION);
  if (!v) return null;
  return String(v).toUpperCase();
}
function setSimDecision(v) {
  if (!v) localStorage.removeItem(KEY_SIM_DECISION);
  else localStorage.setItem(KEY_SIM_DECISION, String(v).toUpperCase());
  updateOpsOverrideText();
}

// ---------- SERVICE WORKER ----------
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    log("Service Worker not supported");
    return;
  }
  try {
    await navigator.serviceWorker.register("./sw.js");
    log("Service Worker registered ✅");
  } catch {
    log("Service Worker registration failed ❌");
  }
}

// ---------- MAP ----------
function addBaseTiles() {
  baseTileLayer = L.tileLayer(OSM_TILES, {
    maxZoom: 18,
    crossOrigin: true,
    attribution: "&copy; OpenStreetMap contributors"
  });

  baseTileLayer.on("tileerror", () => {
    if (!window.__tileErrorLogged) {
      window.__tileErrorLogged = true;
      log("Map tiles failed to load (offline/blocked). Grid overlay still works ✅");
    }
  });

  baseTileLayer.addTo(map);
}

function initLegend() {
  const legend = L.control({ position: "bottomright" });
  legend.onAdd = function () {
    const div = L.DomUtil.create("div", "leaflet-control");
    div.style.background = "rgba(14,23,48,0.92)";
    div.style.border = "1px solid #223152";
    div.style.color = "#cfe0ff";
    div.style.padding = "10px";
    div.style.borderRadius = "12px";
    div.style.fontSize = "12px";
    div.style.fontWeight = "800";
    div.innerHTML = `
      <div style="margin-bottom:6px">Grid Risk Legend</div>
      <div style="display:flex;gap:8px;align-items:center;margin:4px 0;">
        <span style="width:14px;height:14px;background:#26d07c;border-radius:4px;display:inline-block"></span> LOW (0.00–0.35)
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin:4px 0;">
        <span style="width:14px;height:14px;background:#ffb020;border-radius:4px;display:inline-block"></span> MED (0.35–0.70)
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin:4px 0;">
        <span style="width:14px;height:14px;background:#ff4d4f;border-radius:4px;display:inline-block"></span> HIGH (0.70–1.00)
      </div>
    `;
    return div;
  };
  legend.addTo(map);
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([31.10, 77.17], 16);
  addBaseTiles();

  gridLayer = L.layerGroup().addTo(map);
  zonesLayer = L.layerGroup().addTo(map);

  initLegend();
}

function riskColor(risk) {
  const r = clamp(Number(risk ?? 0), 0, 1);
  if (r >= 0.70) return "#ff4d4f";
  if (r >= 0.35) return "#ffb020";
  return "#26d07c";
}

function riskRowClass(risk) {
  const r = clamp(Number(risk ?? 0), 0, 1);
  if (r >= 0.70) return "rowHigh";
  if (r >= 0.35) return "rowMed";
  return "rowLow";
}

// Convert 30m cell to lat/lon degrees around a given latitude
function makeCellBounds(lat, lon, cellSizeM = 30) {
  const half = cellSizeM / 2;

  // 1 degree lat ≈ 111,320m
  const dLat = half / 111320;

  // 1 degree lon ≈ 111,320m * cos(latitude)
  const latRad = (lat * Math.PI) / 180;
  const dLon = half / (111320 * Math.cos(latRad));

  return [
    [lat - dLat, lon - dLon],
    [lat + dLat, lon + dLon]
  ];
}

function updateGridOnMap(gridCells) {
  gridLayer.clearLayers();

  (gridCells || []).forEach(cell => {
    if (cell.lat == null || cell.lon == null) return;

    const col = riskColor(cell.risk);
    const bounds = makeCellBounds(cell.lat, cell.lon, 30);

    const rect = L.rectangle(bounds, {
      color: col,
      weight: 1,
      fillColor: col,
      fillOpacity: 0.45
    });

    rect.bindPopup(`
      <b>Grid ${cell.grid_no || "-"}</b><br/>
      Risk: <b style="color:${col}">${Number(cell.risk ?? 0).toFixed(2)}</b><br/>
      Soil saturation: ${Number(cell.soil_saturation ?? 0).toFixed(2)}<br/>
      Rainfall: ${Number(cell.rainfall_mm ?? 0).toFixed(1)} mm<br/>
      Vibration: ${Number(cell.vibration ?? 0)} / 10<br/>
      Lat,Lon: ${cell.lat}, ${cell.lon}
    `);

    rect.on("mouseover", () => rect.setStyle({ weight: 2, fillOpacity: 0.70 }));
    rect.on("mouseout", () => rect.setStyle({ weight: 1, fillOpacity: 0.45 }));

    rect.addTo(gridLayer);
  });
}

// ---------- ZONES (optional, still supported) ----------
function zoneStyle(action) {
  const a = String(action || "SAFE").toUpperCase();
  if (a === "EVACUATE") return { color: "#ff4d4f", fillColor: "#ff4d4f", fillOpacity: 0.12, weight: 2 };
  if (a === "WATCH") return { color: "#ffb020", fillColor: "#ffb020", fillOpacity: 0.12, weight: 2 };
  return { color: "#26d07c", fillColor: "#26d07c", fillOpacity: 0.10, weight: 2 };
}

function updateZonesOnMap(zones) {
  zonesLayer.clearLayers();

  (zones || []).forEach(z => {
    if (z.lat == null || z.lon == null) return;

    const style = zoneStyle(z.action);
    const radius = Number(z.radius_m ?? 180);

    const circle = L.circle([z.lat, z.lon], { radius, ...style });

    circle.bindPopup(
      `<b>${z.name}</b><br/>Action: <b>${String(z.action).toUpperCase()}</b><br/>Shelter: ${z.shelter || "-"}`
    );

    circle.addTo(zonesLayer);
  });
}

// ---------- UI ----------
function setBannerDecision(payload, decisionOverride = null, confOverride = null) {
  const banner = document.getElementById("decisionBanner");
  const decisionText = document.getElementById("decisionText");
  const confText = document.getElementById("confidenceText");
  const leadText = document.getElementById("leadTimeText");
  const districtName = document.getElementById("districtName");
  const summaryText = document.getElementById("summaryText");

  const district = payload.district || "—";
  const decision = String(decisionOverride ?? payload.decision ?? "NO").toUpperCase();
  const confidence = Number(confOverride ?? payload.confidence ?? 0);
  const lead = payload.lead_time_hours ?? 6;

  districtName.textContent = district;
  summaryText.textContent = payload.summary || "—";

  banner.classList.remove("yes", "no", "neutral");
  decisionText.classList.remove("yes", "no");

  if (decision === "YES") {
    banner.classList.add("yes");
    decisionText.classList.add("yes");
  } else {
    banner.classList.add("no");
    decisionText.classList.add("no");
  }

  decisionText.textContent = decision;
  confText.textContent = confidence.toFixed(2);
  leadText.textContent = `${lead} hours`;
}

function setPlaybackText() {
  const el = document.getElementById("playbackText");
  if (!el) return;

  if (!playback.enabled) {
    el.textContent = "LIVE";
    el.style.color = "#c9ffe8";
    return;
  }

  el.textContent = `PLAYBACK @ ${playback.t || "—"}`;
  el.style.color = "#ffe7c2";
}

function setChips(payload) {
  const row = document.getElementById("chipRow");
  row.innerHTML = "";

  (payload.factors || []).slice(0, 4).forEach(f => {
    const level = String(f.level || "LOW").toUpperCase();
    const chip = document.createElement("div");
    chip.className = "chip " + (level === "HIGH" ? "high" : level === "MEDIUM" ? "medium" : "low");
    chip.textContent = `${f.name}: ${f.value}`;
    row.appendChild(chip);
  });
}

function setFactors(payload) {
  const list = document.getElementById("factorList");
  list.innerHTML = "";

  const factors = payload.factors || [];
  if (!factors.length) {
    list.innerHTML = `<div class="muted">No factor info available</div>`;
    return;
  }

  factors.forEach(f => {
    const level = String(f.level || "LOW").toUpperCase();
    const badgeClass = level === "HIGH" ? "high" : level === "MEDIUM" ? "medium" : "low";

    const row = document.createElement("div");
    row.className = "factorRow";
    row.innerHTML = `
      <div class="factorLeft">
        <div class="factorName">${f.name}</div>
        <div class="factorValue">${f.value}</div>
      </div>
      <div class="badge ${badgeClass}">${level}</div>
    `;
    list.appendChild(row);
  });
}

// ✅ GRID TABLE
function setGridTable(payload) {
  const body = document.getElementById("gridBody");
  body.innerHTML = "";

  let grid = payload.grid_cells || [];
  if (!grid.length) {
    body.innerHTML = `<tr><td colspan="8" class="muted">No grid data returned</td></tr>`;
    updateGridOnMap([]);
    return;
  }

  // Sort: highest risk first
  grid = [...grid].sort((a,b) => Number(b.risk ?? 0) - Number(a.risk ?? 0));

  grid.slice(0, 25).forEach((g, idx) => {
    const tr = document.createElement("tr");
    tr.className = riskRowClass(g.risk);
    tr.style.cursor = "pointer";

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td><b>${g.grid_no || "-"}</b></td>
      <td>${g.lat ?? "—"}</td>
      <td>${g.lon ?? "—"}</td>
      <td>${Number(g.soil_saturation ?? 0).toFixed(2)}</td>
      <td>${Number(g.rainfall_mm ?? 0).toFixed(1)}</td>
      <td>${Number(g.vibration ?? 0)}</td>
      <td><b>${Number(g.risk ?? 0).toFixed(2)}</b></td>
    `;

    tr.addEventListener("click", () => {
      if (g.lat != null && g.lon != null) map.setView([g.lat, g.lon], 18);
    });

    body.appendChild(tr);
  });

  updateGridOnMap(payload.grid_cells);
}

function setZonesPanel(payload) {
  const list = document.getElementById("zoneList");
  list.innerHTML = "";

  const zones = payload.evacuation_zones || [];
  if (!zones.length) {
    list.innerHTML = `<div class="muted">No evacuation zones</div>`;
    updateZonesOnMap([]);
    return;
  }

  zones.forEach(z => {
    const action = String(z.action || "SAFE").toUpperCase();
    const actionClass =
      action === "EVACUATE" ? "evac" :
      action === "WATCH" ? "watch" : "safe";

    const row = document.createElement("div");
    row.className = "zoneRow";

    row.innerHTML = `
      <div class="zoneLeft">
        <div class="zoneName">${z.name}</div>
        <div class="zoneMeta">
          Action: <b>${action}</b> • ETA: <b>${z.eta_minutes ?? 0} min</b><br/>
          Shelter: <b>${z.shelter || "-"}</b> • Pop: <b>${z.population_est ?? "-"}</b>
        </div>
        <div class="zoneMeta" style="color:#93a4c7">${z.reason || ""}</div>
      </div>
      <div class="zoneBtns">
        <div class="zoneAction ${actionClass}">${action}</div>
        <button class="btn small secondary">Focus</button>
      </div>
    `;

    row.querySelector("button").addEventListener("click", () => {
      if (z.lat != null && z.lon != null) map.setView([z.lat, z.lon], 17);
    });

    list.appendChild(row);
  });

  updateZonesOnMap(zones);
}

function setSMS(payload) {
  const smsBox = document.getElementById("smsText");
  const smsCount = document.getElementById("smsCount");

  let sms = payload.sms || "";
  sms = String(sms).slice(0, 160);

  smsBox.value = sms;
  smsCount.textContent = sms.length;
}

function setMetrics(payload) {
  document.getElementById("lastUpdate").textContent =
    payload.updated_at_local || new Date().toLocaleString();
}

// ---------- TIMELINE ----------
function drawTimelineChart(history, activeT = null) {
  const canvas = document.getElementById("timelineChart");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e1730";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "#223152";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = (h * i) / 5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (!history || history.length < 2) return;

  const pad = 10;
  const innerH = h - pad * 2;
  const innerW = w - pad * 2;
  const n = history.length;
  const xStep = innerW / (n - 1);

  for (let i = 0; i < n - 1; i++) {
    const a = history[i];
    const b = history[i + 1];

    const ya = pad + (1 - clamp(Number(a.confidence ?? 0), 0, 1)) * innerH;
    const yb = pad + (1 - clamp(Number(b.confidence ?? 0), 0, 1)) * innerH;

    const xa = pad + i * xStep;
    const xb = pad + (i + 1) * xStep;

    const dec = String(b.decision || "NO").toUpperCase();
    ctx.strokeStyle = dec === "YES" ? "#ff4d4f" : "#26d07c";
    ctx.lineWidth = 3;

    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo(xb, yb);
    ctx.stroke();
  }

  for (let i = 0; i < n; i++) {
    const p = history[i];
    const x = pad + i * xStep;
    const y = pad + (1 - clamp(Number(p.confidence ?? 0), 0, 1)) * innerH;
    const dec = String(p.decision || "NO").toUpperCase();

    ctx.fillStyle = dec === "YES" ? "#ff4d4f" : "#26d07c";
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();

    if (activeT && p.t === activeT) {
      ctx.strokeStyle = "#cfe0ff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function setTimeline(payload) {
  const history = payload.history || [];
  drawTimelineChart(history, playback.enabled ? playback.t : null);

  const list = document.getElementById("timelineList");
  list.innerHTML = "";

  const tail = history.slice(-8);
  tail.forEach(p => {
    const dec = String(p.decision || "NO").toUpperCase();
    const row = document.createElement("div");
    row.className = `tRow ${dec === "YES" ? "tYes" : "tNo"} ${playback.enabled && playback.t === p.t ? "tActive" : ""}`;
    row.innerHTML = `
      <div class="tLeft">${p.t || "—"} → <b>${dec}</b></div>
      <div class="tRight">conf ${Number(p.confidence ?? 0).toFixed(2)}</div>
    `;
    row.addEventListener("click", () => enterPlayback(p));
    list.appendChild(row);
  });
}

// ---------- PLAYBACK ----------
function enterPlayback(point) {
  playback.enabled = true;
  playback.t = point.t || null;
  playback.decision = String(point.decision || "NO").toUpperCase();
  playback.confidence = Number(point.confidence ?? 0);

  stopAlarm();
  setPlaybackText();
  updateOpsOverrideText();

  if (lastPayload) {
    applyPayload(lastPayload, `Playback ON @ ${playback.t}`);
  }
}

function exitPlayback() {
  playback.enabled = false;
  playback.t = null;
  playback.decision = null;
  playback.confidence = null;

  setPlaybackText();
  updateOpsOverrideText();

  if (lastPayload) {
    applyPayload(lastPayload, "Returned to LIVE ✅");
  }
}

function startAutoplay() {
  if (!lastPayload || !(lastPayload.history || []).length) return;
  if (autoplayTimer) return;

  log("Autoplay started ▶️");
  const hist = lastPayload.history;
  autoplayIdx = 0;

  autoplayTimer = setInterval(() => {
    if (!hist[autoplayIdx]) {
      stopAutoplay();
      return;
    }
    enterPlayback(hist[autoplayIdx]);
    autoplayIdx += 1;
    if (autoplayIdx >= hist.length) stopAutoplay();
  }, 900);
}

function stopAutoplay() {
  if (!autoplayTimer) return;
  clearInterval(autoplayTimer);
  autoplayTimer = null;
  log("Autoplay stopped ⏹️");
}

// ---------- ACK / ALARM ----------
function updateAckText() {
  const ackEl = document.getElementById("ackText");
  const ackAt = getAckAt();

  if (!ackAt) {
    ackEl.textContent = "NOT ACKED";
    ackEl.style.color = "#ffd6d6";
    return;
  }

  const d = new Date(ackAt);
  ackEl.textContent = `ACK @ ${d.toLocaleTimeString()}`;
  ackEl.style.color = "#c9ffe8";
}

function updateAlarmText() {
  const el = document.getElementById("alarmText");
  el.textContent = getMuted() ? "MUTED" : "ARMED";
}

function playBeepOnce() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();

    o.type = "square";
    o.frequency.value = 880;
    g.gain.value = 0.05;

    o.connect(g);
    g.connect(ctx.destination);

    o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 180);
  } catch {}
}

function shouldAlarm(decisionFinal) {
  if (playback.enabled) return false;
  if (!isYES(decisionFinal)) return false;
  if (getMuted()) return false;
  if (getAckAt()) return false;
  return true;
}

function startAlarm() {
  if (alarmInterval) return;
  log("ALARM ACTIVE 🔥 (YES decision not acknowledged)");
  alarmInterval = setInterval(() => {
    playBeepOnce();
    setTimeout(playBeepOnce, 250);
    setTimeout(playBeepOnce, 500);
  }, 2000);
}

function stopAlarm() {
  if (!alarmInterval) return;
  clearInterval(alarmInterval);
  alarmInterval = null;
  log("Alarm stopped ✅");
}

// ---------- VSAT ----------
function updateVSATButton() {
  const btn = document.getElementById("btnVsat");
  btn.textContent = getVSAT() ? "VSAT: ON" : "VSAT: OFF";
}

function buildSyncPayload(payload) {
  return {
    district: payload.district,
    updated_at_local: payload.updated_at_local,
    decision: payload.decision,
    confidence: payload.confidence,
    lead_time_hours: payload.lead_time_hours,
    grid_cells_top5: (payload.grid_cells || [])
      .slice()
      .sort((a,b) => Number(b.risk ?? 0) - Number(a.risk ?? 0))
      .slice(0, 5),
    sms: String(payload.sms || "").slice(0, 160)
  };
}

function updateSyncBytes(payload) {
  const el = document.getElementById("syncBytes");
  const vsat = getVSAT();
  const syncObj = vsat ? buildSyncPayload(payload) : payload;
  const bytes = new TextEncoder().encode(JSON.stringify(syncObj)).length;
  el.textContent = `${bytes} bytes (${vsat ? "VSAT" : "FULL"})`;
  return bytes;
}

// ---------- OPS CONSOLE ----------
function updateOpsOverrideText() {
  const el = document.getElementById("opsOverride");
  if (!el) return;

  const sim = getSimDecision();
  if (playback.enabled) {
    el.textContent = `PLAYBACK @ ${playback.t || "—"}`;
    el.style.color = "#ffe7c2";
    return;
  }

  if (sim) {
    el.textContent = `SIMULATED: ${sim}`;
    el.style.color = sim === "YES" ? "#ffd6d6" : "#c9ffe8";
    return;
  }

  el.textContent = "LIVE";
  el.style.color = "#c9ffe8";
}

async function updateTileCacheCount() {
  const el = document.getElementById("opsTiles");
  if (!el) return;

  try {
    const cache = await caches.open(TILE_CACHE_NAME);
    const keys = await cache.keys();
    el.textContent = `${keys.length}`;
    el.style.color = keys.length > 0 ? "#c9ffe8" : "#ffe7c2";
  } catch {
    el.textContent = "—";
    el.style.color = "#93a4c7";
  }
}

function updateFieldReadiness(payload, syncBytes) {
  // SMS compliance
  const sms = String(payload.sms || "").slice(0, 160);
  const smsLen = sms.length;
  const smsEl = document.getElementById("opsSms");
  if (smsEl) {
    const ok = smsLen <= 160;
    smsEl.textContent = ok ? `PASS (${smsLen})` : `FAIL (${smsLen})`;
    smsEl.style.color = ok ? "#c9ffe8" : "#ffd6d6";
  }

  // VSAT time @256kbps
  const tSec = (syncBytes * 8) / 256000;
  const vsatEl = document.getElementById("opsVsatTime");
  if (vsatEl) {
    vsatEl.textContent = `${tSec.toFixed(2)} sec`;
    vsatEl.style.color = tSec <= 2 ? "#c9ffe8" : (tSec <= 6 ? "#ffe7c2" : "#ffd6d6");
  }

  updateOpsOverrideText();
}

// ---------- BLACKOUT ----------
function updateBlackoutButton() {
  const btn = document.getElementById("btnBlackout");
  if (!btn) return;
  btn.textContent = getBlackout() ? "Blackout: ON" : "Blackout: OFF";
}

// ---------- CACHE ----------
function saveCache(payload) {
  try { localStorage.setItem(KEY_PAYLOAD, JSON.stringify(payload)); } catch {}
}
function loadCache() {
  try {
    const raw = localStorage.getItem(KEY_PAYLOAD);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// ---------- DATA ----------
async function fetchPayload() {
  const r = await fetch(DATA_URL, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

// ---------- APPLY ----------
function getFinalDecision(payload) {
  if (playback.enabled) return playback.decision;
  const sim = getSimDecision();
  if (sim) return sim;
  return String(payload.decision || "NO").toUpperCase();
}

function getFinalConfidence(payload) {
  if (playback.enabled) return playback.confidence;
  const sim = getSimDecision();
  if (sim) return sim === "YES" ? 0.92 : 0.22;
  return Number(payload.confidence ?? 0);
}

function applyPayload(payload, sourceMsg) {
  lastPayload = payload;

  setMetrics(payload);

  const decisionFinal = getFinalDecision(payload);
  const confFinal = getFinalConfidence(payload);

  setBannerDecision(payload, decisionFinal, confFinal);
  setPlaybackText();

  setChips(payload);
  setFactors(payload);
  setTimeline(payload);
  setZonesPanel(payload);

  // ✅ NEW GRID TABLE + MAP
  setGridTable(payload);

  setSMS(payload);

  const syncBytes = updateSyncBytes(payload);
  updateFieldReadiness(payload, syncBytes);

  updateTileCacheCount();

  saveCache(payload);
  updateAckText();
  updateAlarmText();
  updateVSATButton();
  updateBlackoutButton();

  if (shouldAlarm(decisionFinal)) startAlarm();
  else stopAlarm();

  log(sourceMsg);

  setTimeout(() => { try { map.invalidateSize(); } catch {} }, 50);
}

// ---------- REPORT ----------
function downloadReport(payload) {
  const dec = getFinalDecision(payload);

  const lines = [];
  lines.push("SENTINEL-LEWS SITUATION REPORT");
  lines.push("--------------------------------");
  lines.push(`District: ${payload.district || "-"}`);
  lines.push(`Updated:  ${payload.updated_at_local || new Date().toLocaleString()}`);
  lines.push(`Decision: ${dec}`);
  lines.push(`Confidence: ${(getFinalConfidence(payload)).toFixed(2)}`);
  lines.push(`Lead Time (h): ${payload.lead_time_hours ?? "-"}`);
  lines.push("");
  lines.push("Summary:");
  lines.push(payload.summary || "-");
  lines.push("");

  lines.push("Grid Cells (Top 10 Risk):");
  const top = (payload.grid_cells || [])
    .slice()
    .sort((a,b) => Number(b.risk ?? 0) - Number(a.risk ?? 0))
    .slice(0, 10);

  top.forEach(g => {
    lines.push(`- ${g.grid_no}: risk ${Number(g.risk ?? 0).toFixed(2)} | soil ${Number(g.soil_saturation ?? 0).toFixed(2)} | rain ${Number(g.rainfall_mm ?? 0).toFixed(1)} | vib ${g.vibration} @ ${g.lat},${g.lon}`);
  });

  lines.push("");
  lines.push("SMS:");
  lines.push(String(payload.sms || "").slice(0, 160));
  lines.push("");

  const text = lines.join("\n");
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `LEWS_Report_${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  log("Downloaded Situation Report ✅");
}

// ---------- POLLING ----------
function startPolling() {
  const ms = getVSAT() ? POLL_VSAT_MS : POLL_NORMAL_MS;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, ms);
}

function restartPolling() {
  startPolling();
  log(`Polling restarted (${getVSAT() ? "VSAT" : "NORMAL"} mode)`);
}

// ---------- MAIN ----------
async function refresh() {
  if (getBlackout()) {
    setConn(false, "BLACKOUT (LOCAL)");
    const cached = loadCache();
    if (cached) applyPayload(cached, "Blackout mode: loaded cache ✅");
    else log("Blackout mode: no cache available ❌");
    return;
  }

  try {
    const payload = await fetchPayload();
    setConn(true);
    applyPayload(payload, "Loaded ./data.json ✅");
  } catch {
    setConn(false);
    const cached = loadCache();
    if (cached) applyPayload(cached, "Loaded cached payload ✅ (offline)");
    else log("No cache available ❌");
  }
}

// ---------- BOOT ----------
window.addEventListener("load", async () => {
  await registerServiceWorker();
  initMap();

  document.getElementById("btnRefresh").addEventListener("click", refresh);

  document.getElementById("btnCopySms").addEventListener("click", async () => {
    const txt = document.getElementById("smsText").value || "";
    try {
      await navigator.clipboard.writeText(txt);
      log("SMS copied ✅");
    } catch {
      log("Clipboard blocked ❌ (copy manually)");
    }
  });

  document.getElementById("btnAck").addEventListener("click", () => {
    if (!lastPayload) return;
    const decisionFinal = getFinalDecision(lastPayload);
    if (!isYES(decisionFinal)) {
      log("ACK ignored (decision is NO)");
      return;
    }
    setAckNow();
    stopAlarm();
    log("ALERT ACKNOWLEDGED ✅");
  });

  document.getElementById("btnMute").addEventListener("click", () => {
    const muted = getMuted();
    setMuted(!muted);
    document.getElementById("btnMute").textContent = !muted ? "Unmute" : "Mute";

    if (lastPayload && shouldAlarm(getFinalDecision(lastPayload))) startAlarm();
    else stopAlarm();

    log(!muted ? "Alarm muted ✅" : "Alarm unmuted ✅");
  });

  document.getElementById("btnReport").addEventListener("click", () => {
    const payload = lastPayload || loadCache();
    if (!payload) { log("No payload available for report ❌"); return; }
    downloadReport(payload);
  });

  document.getElementById("btnVsat").addEventListener("click", () => {
    setVSAT(!getVSAT());
  });

  document.getElementById("btnLive").addEventListener("click", () => {
    stopAutoplay();
    exitPlayback();
  });

  document.getElementById("btnAuto").addEventListener("click", () => {
    if (autoplayTimer) stopAutoplay();
    else startAutoplay();
  });

  document.getElementById("btnBlackout").addEventListener("click", () => {
    setBlackout(!getBlackout());
    refresh();
    log(getBlackout() ? "Blackout enabled ✅" : "Blackout disabled ✅");
  });

  document.getElementById("btnSimYes").addEventListener("click", () => {
    setSimDecision("YES");
    if (lastPayload) applyPayload(lastPayload, "Simulated decision = YES ✅");
  });

  document.getElementById("btnSimNo").addEventListener("click", () => {
    setSimDecision("NO");
    if (lastPayload) applyPayload(lastPayload, "Simulated decision = NO ✅");
  });

  document.getElementById("btnClearAck").addEventListener("click", () => {
    clearAck();
    if (lastPayload) applyPayload(lastPayload, "ACK cleared ✅");
  });

  // Boot from cache
  const cached = loadCache();
  if (cached) {
    setConn(false);
    applyPayload(cached, "Booted from cache ✅");
  } else {
    updateAckText();
    updateAlarmText();
    updateVSATButton();
    updateBlackoutButton();
    updateOpsOverrideText();
    log("Booting fresh…");
  }

  document.getElementById("btnMute").textContent = getMuted() ? "Unmute" : "Mute";

  refresh();
  startPolling();
});
