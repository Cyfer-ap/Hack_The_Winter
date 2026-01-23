// ======================
// CONFIG
// ======================
const DATA_URL = "./sensor_data.json";


const POLL_NORMAL_MS = 5000;
const POLL_VSAT_MS   = 20000;

const OSM_TILES = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

const KEY_CACHE_ZONES = "lews_zones_cache";
const KEY_ACK_AT      = "lews_ack_at";
const KEY_MUTED       = "lews_muted";
const KEY_VSAT        = "lews_vsat";
const KEY_BLACKOUT    = "lews_blackout";

const TILE_CACHE_NAME = "lews-tiles-v1";

// ======================
// STATE
// ======================
let map, zonesLayer;
let lastZones = null;
let pollTimer = null;
let alarmInterval = null;
let lastGoodFetchAt = null;

// ======================
// HELPERS
// ======================
const $ = (id) => document.getElementById(id);

function log(msg, ok = true) {
  const el = $("log");
  if (!el) return;
  const ts = new Date().toLocaleTimeString();
  const icon = ok ? "✅" : "❌";
  el.innerHTML = `[${ts}] ${msg} ${icon}\n` + el.innerHTML;
}

function setConn(ok, labelOverride = null) {
  const dot = $("connDot");
  const text = $("connText");
  if (!dot || !text) return;

  dot.className = "dot " + (ok ? "green" : "red");
  text.textContent = labelOverride || (ok ? "LIVE FEED OK" : "OFFLINE (CACHE)");
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function riskToColor(riskText, prob = null) {
  const r = String(riskText || "").toUpperCase();
  if (r === "HIGH") return "#ff4d4f";
  if (r === "MODERATE" || r === "MEDIUM") return "#ffb020";
  if (r === "LOW") return "#26d07c";

  const p = clamp(Number(prob ?? 0), 0, 1);
  if (p >= 0.7) return "#ff4d4f";
  if (p >= 0.35) return "#ffb020";
  return "#26d07c";
}

function formatISO(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || "-");
    return d.toLocaleString();
  } catch {
    return String(iso || "-");
  }
}

// ======================
// SETTINGS
// ======================
function getMuted() { return localStorage.getItem(KEY_MUTED) === "1"; }
function setMuted(v) { localStorage.setItem(KEY_MUTED, v ? "1" : "0"); updateAlarmText(); }

function getAckAt() { return localStorage.getItem(KEY_ACK_AT); }
function setAckNow() { localStorage.setItem(KEY_ACK_AT, new Date().toISOString()); updateAckText(); }
function clearAck() { localStorage.removeItem(KEY_ACK_AT); updateAckText(); }

function getVSAT() { return localStorage.getItem(KEY_VSAT) === "1"; }
function setVSAT(v) { localStorage.setItem(KEY_VSAT, v ? "1" : "0"); updateVSATButton(); restartPolling(); }

function getBlackout() { return localStorage.getItem(KEY_BLACKOUT) === "1"; }
function setBlackout(v) { localStorage.setItem(KEY_BLACKOUT, v ? "1" : "0"); updateBlackoutButton(); }

// ======================
// SERVICE WORKER
// ======================
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    log("Service Worker not supported", false);
    return;
  }
  try {
    await navigator.serviceWorker.register("./sw.js");
    log("Service Worker registered");
  } catch {
    log("Service Worker registration failed", false);
  }
}

// ======================
// MAP
// ======================
function initMap() {
  map = L.map("map", { zoomControl: true }).setView([31.1045, 77.1740], 15);
  const tileLayer = L.tileLayer(OSM_TILES, {
    maxZoom: 18,
    crossOrigin: true,
    attribution: "&copy; OpenStreetMap contributors"
  });

  tileLayer.on("tileerror", () => {
    // Tiles might fail offline, but zones still show
  });

  tileLayer.addTo(map);
  zonesLayer = L.layerGroup().addTo(map);
}

function makeZoneTooltipHTML(z) {
  const col = riskToColor(z.risk, z.probability);
  return `
    <div>
      <div style="margin-bottom:6px"><b>${z.zone_id || "ZONE"}</b></div>
      <div>Risk: <b style="color:${col}">${String(z.risk || "-").toUpperCase()}</b></div>
      <div>Probability: <b>${Number(z.probability ?? 0).toFixed(2)}</b></div>
      <div>Lead time: <b>${z.lead_time_hours ?? "-"} hours</b></div>
      <div>Zone size: <b>${z.zone_size_m ?? "-"} m</b></div>
      <div style="margin-top:8px;color:#93a4c7">
        Lat/Lon: ${z.latitude}, ${z.longitude}
      </div>
      <div style="margin-top:6px;color:#93a4c7">
        Updated: ${formatISO(z.last_updated)}
      </div>
      <div style="margin-top:6px;color:#93a4c7">
        Sender: ${z.sender_ip || "-"}
      </div>
    </div>
  `;
}

function updateZonesOnMap(zones) {
  if (!zonesLayer) return;

  zonesLayer.clearLayers();
  if (!zones || !zones.length) return;

  // focus = highest probability/highest risk
  let focus = zones[0];

  zones.forEach(z => {
    if (z.latitude == null || z.longitude == null) return;

    const col = riskToColor(z.risk, z.probability);
    const radiusM = Number(z.zone_size_m ?? 100);

    const circle = L.circle([z.latitude, z.longitude], {
      radius: radiusM,
      color: col,
      fillColor: col,
      weight: 2,
      fillOpacity: 0.35
    });

    // ✅ hover tooltip (no click)
    circle.bindTooltip(makeZoneTooltipHTML(z), {
      sticky: true,
      direction: "top",
      opacity: 0.98,
      className: "zoneTip"
    });

    circle.on("mouseover", () => circle.setStyle({ weight: 3, fillOpacity: 0.60 }));
    circle.on("mouseout", () => circle.setStyle({ weight: 2, fillOpacity: 0.35 }));

    circle.addTo(zonesLayer);

    // choose focus (HIGH risk wins, else higher probability)
    const zr = String(z.risk || "").toUpperCase();
    const fr = String(focus.risk || "").toUpperCase();
    if (zr === "HIGH" && fr !== "HIGH") focus = z;
    else if (zr === fr && Number(z.probability ?? 0) > Number(focus.probability ?? 0)) focus = z;
  });

  if (!lastZones && focus.latitude != null && focus.longitude != null) {
    map.setView([focus.latitude, focus.longitude], Math.max(map.getZoom(), 15));
  }
}

// ======================
// UI TABLE
// ======================
function setZoneTable(zones) {
  const body = $("zoneBody");
  if (!body) return;

  body.innerHTML = "";

  if (!zones || !zones.length) {
    body.innerHTML = `<tr><td colspan="9" class="muted">No zones received</td></tr>`;
    return;
  }

  zones.forEach(z => {
    const risk = String(z.risk || "").toUpperCase();
    const cls = risk === "HIGH" ? "rowHigh" : (risk === "MODERATE" || risk === "MEDIUM") ? "rowMed" : "rowLow";

    const tr = document.createElement("tr");
    tr.className = cls;
    tr.style.cursor = "pointer";

    tr.innerHTML = `
      <td><b>${z.zone_id ?? "-"}</b></td>
      <td><b>${risk}</b></td>
      <td>${Number(z.probability ?? 0).toFixed(2)}</td>
      <td>${z.lead_time_hours ?? "-"}</td>
      <td>${z.latitude ?? "-"}</td>
      <td>${z.longitude ?? "-"}</td>
      <td>${z.zone_size_m ?? "-"}</td>
      <td>${formatISO(z.last_updated)}</td>
      <td>${z.sender_ip ?? "-"}</td>
    `;

    tr.addEventListener("click", () => {
      if (z.latitude != null && z.longitude != null) map.setView([z.latitude, z.longitude], 17);
    });

    body.appendChild(tr);
  });
}

// ======================
// METRICS / OPS
// ======================
async function updateTileCacheCount() {
  const el = $("opsTiles");
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

function updateFeedHealth(ok) {
  const el = $("feedHealth");
  if (!el) return;

  if (ok) {
    el.textContent = "LIVE";
    el.style.color = "#c9ffe8";
  } else {
    el.textContent = "STALE";
    el.style.color = "#ffd6d6";
  }
}

function setLastUpdate(zones) {
  const el = $("lastUpdate");
  if (!el) return;

  // pick newest timestamp inside data
  let newest = null;
  (zones || []).forEach(z => {
    if (!z.last_updated) return;
    if (!newest || String(z.last_updated) > String(newest)) newest = z.last_updated;
  });

  el.textContent = newest ? formatISO(newest) : new Date().toLocaleString();
}

function updateAckText() {
  const ackAt = getAckAt();
  // optional: you can show this somewhere if needed
}

function updateAlarmText() {
  const el = $("alarmText");
  if (!el) return;
  el.textContent = getMuted() ? "MUTED" : "ARMED";
  el.style.color = getMuted() ? "#ffe7c2" : "#c9ffe8";
}

function updateVSATButton() {
  const btn = $("btnVsat");
  if (!btn) return;
  btn.textContent = getVSAT() ? "VSAT: ON" : "VSAT: OFF";
}

function updateBlackoutButton() {
  const btn = $("btnBlackout");
  if (!btn) return;
  btn.textContent = getBlackout() ? "Blackout: ON" : "Blackout: OFF";
}

// ======================
// ALARM (HIGH zones)
// ======================
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

function shouldAlarm(zones) {
  if (!zones || !zones.length) return false;
  if (getMuted()) return false;
  if (getAckAt()) return false;
  return zones.some(z => String(z.risk || "").toUpperCase() === "HIGH");
}

function startAlarm() {
  if (alarmInterval) return;
  log("ALARM ACTIVE (HIGH risk zone not acknowledged)");
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
  log("Alarm stopped");
}

// ======================
// CACHE
// ======================
function saveCache(zones) {
  try { localStorage.setItem(KEY_CACHE_ZONES, JSON.stringify(zones)); } catch {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem(KEY_CACHE_ZONES);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// ======================
// FETCH (LIVE JSON)
// ======================
async function fetchZones() {
  // ✅ absolute safe URL (prevents path issues)
  const absUrl = new URL(DATA_URL, window.location.href).toString();

  const res = await fetch(absUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${absUrl}`);

  const text = await res.text(); // ✅ handle partial/invalid updates safely
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("JSON parse failed (file may be mid-write)");
  }

  if (!Array.isArray(data)) throw new Error("sensor_data.json is not an array");
  return data;
}

function normalizeZones(raw) {
  const zones = Array.isArray(raw) ? raw : [];

  // sort by risk then probability (HIGH first)
  zones.sort((a, b) => {
    const order = { HIGH: 3, MODERATE: 2, MEDIUM: 2, LOW: 1 };
    const ra = order[String(a.risk || "").toUpperCase()] || 0;
    const rb = order[String(b.risk || "").toUpperCase()] || 0;
    if (rb !== ra) return rb - ra;
    return Number(b.probability ?? 0) - Number(a.probability ?? 0);
  });

  return zones;
}

// ======================
// APPLY
// ======================
function applyZones(zones, sourceMsg) {
  lastZones = zones;

  setZoneTable(zones);
  updateZonesOnMap(zones);
  setLastUpdate(zones);

  updateFeedHealth(true);
  lastGoodFetchAt = Date.now();

  saveCache(zones);

  updateAlarmText();
  updateVSATButton();
  updateBlackoutButton();
  updateTileCacheCount();

  if (shouldAlarm(zones)) startAlarm();
  else stopAlarm();

  log(sourceMsg);
}

// ======================
// POLLING
// ======================
function startPolling() {
  const ms = getVSAT() ? POLL_VSAT_MS : POLL_NORMAL_MS;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, ms);
}

function restartPolling() {
  startPolling();
  log(`Polling restarted (${getVSAT() ? "VSAT" : "NORMAL"} mode)`);
}

// ======================
// MAIN REFRESH
// ======================
async function refresh() {
  // BLACKOUT = cache only
  if (getBlackout()) {
    setConn(false, "BLACKOUT (LOCAL)");
    const cached = loadCache();
    if (cached) {
      applyZones(normalizeZones(cached), "Blackout: loaded cached zones");
    } else {
      updateFeedHealth(false);
      log("Blackout: no cache available", false);
    }
    return;
  }

  try {
    const raw = await fetchZones();
    const zones = normalizeZones(raw);

    setConn(true, "LIVE FEED OK");
    applyZones(zones, `Loaded ${zones.length} zones from scripts/sensor_data.json`);
  } catch (e) {
    setConn(false, "OFFLINE (CACHE)");

    // keep last zones if available
    const cached = loadCache();
    if (cached) {
      applyZones(normalizeZones(cached), `Fetch failed → using cached zones (${String(e.message)})`);
    } else {
      updateFeedHealth(false);
      log(`Fetch failed (${String(e.message)})`, false);
    }
  }
}

// ======================
// REPORT
// ======================
function downloadReport(zones) {
  const lines = [];
  lines.push("SENTINEL-LEWS ZONE REPORT");
  lines.push("--------------------------------");
  lines.push(`Generated: ${new Date().toLocaleString()}`);
  lines.push("");

  (zones || []).forEach(z => {
    lines.push(`${z.zone_id} | ${String(z.risk).toUpperCase()} | P=${Number(z.probability ?? 0).toFixed(2)} | lead=${z.lead_time_hours}h | size=${z.zone_size_m}m`);
    lines.push(`lat=${z.latitude}, lon=${z.longitude} | updated=${formatISO(z.last_updated)} | sender=${z.sender_ip}`);
    lines.push("");
  });

  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `LEWS_Zones_${stamp}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  log("Downloaded report");
}

// ======================
// BOOT
// ======================
window.addEventListener("load", async () => {
  await registerServiceWorker();
  initMap();

  updateAlarmText();
  updateVSATButton();
  updateBlackoutButton();
  updateTileCacheCount();

  $("btnRefresh")?.addEventListener("click", refresh);

  $("btnVsat")?.addEventListener("click", () => {
    setVSAT(!getVSAT());
  });

  $("btnMute")?.addEventListener("click", () => {
    const muted = getMuted();
    setMuted(!muted);
    $("btnMute").textContent = !muted ? "Unmute" : "Mute";

    if (lastZones && shouldAlarm(lastZones)) startAlarm();
    else stopAlarm();

    log(!muted ? "Alarm muted" : "Alarm unmuted");
  });

  $("btnAck")?.addEventListener("click", () => {
    if (!lastZones || !lastZones.length) {
      log("ACK ignored (no zones)", false);
      return;
    }
    setAckNow();
    stopAlarm();
    log("ALERT ACKNOWLEDGED (shown only, no SMS sending)");
  });

  $("btnBlackout")?.addEventListener("click", () => {
    setBlackout(!getBlackout());
    refresh();
    log(getBlackout() ? "Blackout enabled" : "Blackout disabled");
  });

  $("btnClearAck")?.addEventListener("click", () => {
    clearAck();
    log("ACK cleared");
    if (lastZones && shouldAlarm(lastZones)) startAlarm();
  });

  $("btnReport")?.addEventListener("click", () => {
    const zones = lastZones || loadCache();
    if (!zones) { log("No zones available for report", false); return; }
    downloadReport(zones);
  });

  // boot from cache (optional)
  const cached = loadCache();
  if (cached) {
    setConn(false, "OFFLINE (CACHE)");
    applyZones(normalizeZones(cached), "Booted from cache");
  } else {
    setConn(false, "OFFLINE (CACHE)");
    updateFeedHealth(false);
    log("Booting fresh...");
  }

  refresh();
  startPolling();
});
