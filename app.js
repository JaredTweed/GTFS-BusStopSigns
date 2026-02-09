/* eslint-disable no-console */
/**
 * GTFS Bus Stop Map + Sign Generator (static site)
 * - Loads google_transit.zip (or user-selected zip)
 * - Parses: stops.txt, routes.txt, trips.txt, stop_times.txt
 * - Builds a stop_id -> [trip_id...] index (from stop_times)
 * - On stop click: compute routes serving that stop, grouped by direction/headsign
 * - Draws a clean printable sign to <canvas> and offers PNG download
 *
 * This is meant to be understandable and hackable, not the final polished UX.
 */

const DEFAULT_ZIP_URL = "./google_transit.zip";

const el = (id) => document.getElementById(id);

const ui = {
  zipName: el("zipName"),
  stopsCount: el("stopsCount"),
  routesCount: el("routesCount"),
  tripsCount: el("tripsCount"),
  indexCount: el("indexCount"),
  progressBar: el("progressBar"),
  progressText: el("progressText"),
  reloadBtn: el("reloadBtn"),
  gtfsFile: el("gtfsFile"),
  modal: el("modal"),
  modalBackdrop: el("modalBackdrop"),
  closeModal: el("closeModal"),
  modalTitle: el("modalTitle"),
  modalSubtitle: el("modalSubtitle"),
  directionSelect: el("directionSelect"),
  maxRoutes: el("maxRoutes"),
  downloadBtn: el("downloadBtn"),
  signCanvas: el("signCanvas"),
};

let map;
let markerCluster;

// GTFS data stores
let stops = [];          // [{stop_id, stop_name, stop_lat, stop_lon, stop_code?}]
let routesById = new Map(); // route_id -> {route_short_name, route_long_name, route_color, route_text_color}
let tripsById = new Map();  // trip_id -> {route_id, direction_id, trip_headsign}
let stopToTrips = new Map();// stop_id -> Set(trip_id)

// Selected stop
let selectedStop = null;
let selectedStopRouteSummary = null;

function setProgress(pct, text) {
  ui.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  ui.progressText.textContent = text;
}

function niceInt(x) {
  try { return new Intl.NumberFormat().format(x); } catch { return String(x); }
}

function safeParseFloat(x) {
  const v = Number.parseFloat(x);
  return Number.isFinite(v) ? v : null;
}

function parseCSVFromZip(zip, filename, { stepRow, complete } = {}) {
  const file = zip.file(filename);
  if (!file) throw new Error(`Missing ${filename} in GTFS zip`);
  return file.async("string").then((text) => {
    return new Promise((resolve, reject) => {
      Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: false,
        step: stepRow ? (results) => stepRow(results.data) : undefined,
        complete: (res) => {
          if (complete) complete(res.data);
          resolve(res.data);
        },
        error: (err) => reject(err),
      });
    });
  });
}

async function loadZipFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return JSZip.loadAsync(buf);
}

async function loadZipFromFile(file) {
  const buf = await file.arrayBuffer();
  return JSZip.loadAsync(buf);
}

function initMap() {
  map = L.map("map", { preferCanvas: true }).setView([49.25, -123.12], 11);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  markerCluster = L.markerClusterGroup({
    chunkedLoading: true,
    showCoverageOnHover: false,
    maxClusterRadius: 55,
  });
  map.addLayer(markerCluster);
}

function addStopsToMap() {
  markerCluster.clearLayers();

  for (const s of stops) {
    const lat = safeParseFloat(s.stop_lat);
    const lon = safeParseFloat(s.stop_lon);
    if (lat == null || lon == null) continue;

    const m = L.circleMarker([lat, lon], {
      radius: 4,
      weight: 1,
      fillOpacity: 0.85,
    });

    const title = s.stop_name || "Stop";
    const code = s.stop_code ? ` (${s.stop_code})` : "";
    m.bindTooltip(`${title}${code}`, { direction: "top" });

    m.on("click", () => openStop(s));
    markerCluster.addLayer(m);
  }
}

function openModal() {
  ui.modal.classList.remove("hidden");
}
function closeModal() {
  ui.modal.classList.add("hidden");
}

ui.modalBackdrop.addEventListener("click", closeModal);
ui.closeModal.addEventListener("click", closeModal);

function normalizeColor(hex, fallback="#333333") {
  if (!hex) return fallback;
  const v = String(hex).trim().replace("#", "");
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v}`;
  if (/^[0-9a-fA-F]{3}$/.test(v)) return `#${v}`;
  return fallback;
}

function pickTextColor(bgHex) {
  // Simple luminance-based selection
  const hex = bgHex.replace("#", "");
  const r = parseInt(hex.slice(0,2), 16) / 255;
  const g = parseInt(hex.slice(2,4), 16) / 255;
  const b = parseInt(hex.slice(4,6), 16) / 255;
  const lum = 0.2126*r + 0.7152*g + 0.0722*b;
  return lum < 0.55 ? "#ffffff" : "#111111";
}

function computeRouteSummaryForStop(stop, directionFilter) {
  const tripSet = stopToTrips.get(stop.stop_id);
  if (!tripSet || tripSet.size === 0) return [];

  // key -> {route_id, direction_id, headsign, count}
  const agg = new Map();

  for (const tripId of tripSet) {
    const t = tripsById.get(tripId);
    if (!t) continue;

    const dir = (t.direction_id === "" || t.direction_id == null) ? null : String(t.direction_id);
    if (directionFilter !== "all" && String(dir) !== String(directionFilter)) continue;

    const route = routesById.get(t.route_id);
    if (!route) continue;

    const headsign = (t.trip_headsign && String(t.trip_headsign).trim()) || (route.route_long_name || route.route_short_name || "");
    const k = `${t.route_id}||${dir ?? ""}||${headsign}`;
    const cur = agg.get(k) || { route_id: t.route_id, direction_id: dir, headsign, count: 0 };
    cur.count += 1;
    agg.set(k, cur);
  }

  // Convert & sort by popularity (trip count proxy), then route number
  const items = Array.from(agg.values()).map((x) => {
    const r = routesById.get(x.route_id);
    const shortName = (r?.route_short_name ?? "").toString().trim();
    return { ...x, route_short_name: shortName, route_color: normalizeColor(r?.route_color, "#3b82f6") };
  });

  items.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    // Numeric-ish route sorting
    const an = parseInt(a.route_short_name, 10);
    const bn = parseInt(b.route_short_name, 10);
    const aIsNum = Number.isFinite(an);
    const bIsNum = Number.isFinite(bn);
    if (aIsNum && bIsNum && an !== bn) return an - bn;
    if (aIsNum !== bIsNum) return aIsNum ? -1 : 1;
    return a.route_short_name.localeCompare(b.route_short_name);
  });

  return items;
}

function drawSign({ stop, items, directionFilter, maxRoutes }) {
  const canvas = ui.signCanvas;
  const ctx = canvas.getContext("2d");

  // Scale for crispness
  const W = 900, H = 1200;
  canvas.width = W; canvas.height = H;

  // Background
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Header area
  const pad = 50;
  const headerH = 170;

  ctx.fillStyle = "#111111";
  ctx.font = "900 56px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  ctx.fillText("Bus Stop", pad, 80);

  // Stop code / id
  const code = stop.stop_code ? `#${stop.stop_code}` : `#${stop.stop_id}`;
  ctx.font = "700 28px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  ctx.fillStyle = "#333333";
  ctx.fillText(code, pad, 120);

  // Simple "T" block like the examples (placeholder)
  const tX = W - pad - 110, tY = 35, tS = 110;
  ctx.fillStyle = "#2b6dff";
  roundRect(ctx, tX, tY, tS, tS, 18, true, false);
  ctx.fillStyle = "#ffffff";
  ctx.font = "900 72px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("T", tX + tS/2, tY + tS/2 + 3);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // Stop name / direction label
  const subtitle = `${stop.stop_name || "—"} • ${directionFilter === "all" ? "All directions" : `Direction ${directionFilter}`}`;
  ctx.fillStyle = "#666666";
  ctx.font = "600 22px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  ctx.fillText(subtitle, pad, headerH);

  // Route pills
  const top = headerH + 40;
  const rowH = 90;
  const pillR = 34;
  const gap = 18;

  const shown = items.slice(0, maxRoutes);
  if (shown.length === 0) {
    ctx.fillStyle = "#111111";
    ctx.font = "700 26px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.fillText("No route/trip data found for this stop (in the loaded GTFS).", pad, top);
    return;
  }

  // Section label
  ctx.fillStyle = "#111111";
  ctx.font = "800 26px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  ctx.fillText("Routes", pad, top - 18);

  let y = top + 30;
  for (const it of shown) {
    const r = routesById.get(it.route_id);
    const routeNum = (r?.route_short_name ?? "").toString().trim() || "•";
    const dest = (it.headsign || r?.route_long_name || r?.route_short_name || "").toString().trim();

    const bg = normalizeColor(r?.route_color, it.route_color || "#3b82f6");
    const fg = r?.route_text_color ? normalizeColor(r.route_text_color, pickTextColor(bg)) : pickTextColor(bg);

    // Circle
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(pad + pillR, y, pillR, 0, Math.PI * 2);
    ctx.fill();

    // Route number
    ctx.fillStyle = fg;
    ctx.font = "900 30px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(routeNum, pad + pillR, y + 1);

    // Destination
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#111111";
    ctx.font = "800 28px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.fillText(dest.slice(0, 40), pad + (pillR*2) + 18, y + 10);

    // Secondary label (direction id + popularity proxy)
    const meta = `dir ${it.direction_id ?? "?"} • patterns: ${it.count}`;
    ctx.fillStyle = "#666666";
    ctx.font = "600 18px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.fillText(meta, pad + (pillR*2) + 18, y + 40);

    y += rowH;
    if (y > H - 120) break;
  }

  // Footer
  ctx.fillStyle = "#888888";
  ctx.font = "600 16px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  ctx.fillText("Generated from GTFS • edit styles in app.js", pad, H - 40);
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function openStop(stop) {
  selectedStop = stop;

  ui.modalTitle.textContent = stop.stop_name || "Bus Stop";
  ui.modalSubtitle.textContent = stop.stop_code ? `Stop #${stop.stop_code}` : `Stop ID: ${stop.stop_id}`;

  const directionFilter = ui.directionSelect.value || "all";
  const maxRoutes = Math.max(4, Math.min(20, parseInt(ui.maxRoutes.value || "6", 10)));

  selectedStopRouteSummary = computeRouteSummaryForStop(stop, directionFilter);
  drawSign({ stop, items: selectedStopRouteSummary, directionFilter, maxRoutes });

  openModal();
}

ui.directionSelect.addEventListener("change", () => {
  if (!selectedStop) return;
  openStop(selectedStop);
});

ui.maxRoutes.addEventListener("change", () => {
  if (!selectedStop) return;
  openStop(selectedStop);
});

ui.downloadBtn.addEventListener("click", () => {
  const stop = selectedStop;
  if (!stop) return;

  const canvas = ui.signCanvas;
  const name = (stop.stop_name || "bus_stop").toString().replace(/[^\w\-]+/g, "_").slice(0, 50);
  const code = (stop.stop_code || stop.stop_id || "").toString().replace(/[^\w\-]+/g, "_").slice(0, 30);
  const dir = ui.directionSelect.value || "all";
  const filename = `${name}_${code}_dir-${dir}.png`;

  const a = document.createElement("a");
  a.download = filename;
  a.href = canvas.toDataURL("image/png");
  a.click();
});

ui.reloadBtn.addEventListener("click", async () => {
  await boot({ zipUrl: DEFAULT_ZIP_URL, zipName: "google_transit.zip" });
});

ui.gtfsFile.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  await boot({ zipFile: f, zipName: f.name });
});

async function boot({ zipUrl, zipFile, zipName }) {
  setProgress(2, "Loading GTFS zip…");
  ui.zipName.textContent = zipName;

  // Clear previous data
  stops = [];
  routesById = new Map();
  tripsById = new Map();
  stopToTrips = new Map();
  selectedStop = null;
  selectedStopRouteSummary = null;

  try {
    const zip = zipFile ? await loadZipFromFile(zipFile) : await loadZipFromUrl(zipUrl);

    // 1) stops.txt (small-ish)
    setProgress(10, "Parsing stops.txt…");
    stops = await parseCSVFromZip(zip, "stops.txt");
    ui.stopsCount.textContent = niceInt(stops.length);

    // 2) routes.txt (small)
    setProgress(20, "Parsing routes.txt…");
    const routes = await parseCSVFromZip(zip, "routes.txt");
    for (const r of routes) routesById.set(r.route_id, r);
    ui.routesCount.textContent = niceInt(routesById.size);

    // 3) trips.txt (medium)
    setProgress(35, "Parsing trips.txt…");
    const trips = await parseCSVFromZip(zip, "trips.txt");
    for (const t of trips) {
      tripsById.set(t.trip_id, {
        route_id: t.route_id,
        direction_id: (t.direction_id ?? "").toString(),
        trip_headsign: t.trip_headsign ?? "",
      });
    }
    ui.tripsCount.textContent = niceInt(tripsById.size);

    // 4) stop_times.txt (large) → build stop_id -> trip_id Set index
    setProgress(45, "Indexing stop_times.txt (stop → trips)…");
    let rowCount = 0;

    await parseCSVFromZip(zip, "stop_times.txt", {
      stepRow: (row) => {
        rowCount += 1;
        const stopId = row.stop_id;
        const tripId = row.trip_id;
        if (!stopId || !tripId) return;

        let set = stopToTrips.get(stopId);
        if (!set) { set = new Set(); stopToTrips.set(stopId, set); }
        set.add(tripId);

        // Update progress every ~50k lines (rough)
        if (rowCount % 50000 === 0) {
          const pct = 45 + Math.min(50, (rowCount / 600000) * 50); // heuristic
          setProgress(pct, `Indexing stop_times.txt… (${niceInt(rowCount)} rows)`);
        }
      },
    });

    ui.indexCount.textContent = niceInt(stopToTrips.size);
    setProgress(98, "Rendering stops on map…");

    addStopsToMap();

    setProgress(100, "Ready. Click a stop.");
    console.log("Loaded:", { stops: stops.length, routes: routesById.size, trips: tripsById.size, stopToTrips: stopToTrips.size });
  } catch (err) {
    console.error(err);
    setProgress(100, `Error: ${err?.message || err}`);
    alert(`Failed to load GTFS: ${err?.message || err}`);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  initMap();
  await boot({ zipUrl: DEFAULT_ZIP_URL, zipName: "google_transit.zip" });
});
