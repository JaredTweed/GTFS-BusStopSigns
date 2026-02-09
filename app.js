/* eslint-disable no-console */
/**
 * GTFS Bus Stop Map + Sign Generator (static site)
 * - Loads google_transit.zip (or user-selected zip)
 * - Parses: stops.txt, routes.txt, trips.txt, stop_times.txt, shapes.txt
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
  copyBtn: el("copyBtn"),
  signCanvas: el("signCanvas"),
  modalRouteMap: el("modalRouteMap"),
  modalRouteMapHint: el("modalRouteMapHint"),
};

let map;
let markerCluster;
let modalMap;
let modalRouteLayer;

// GTFS data stores
let stops = [];          // [{stop_id, stop_name, stop_lat, stop_lon, stop_code?}]
let routesById = new Map(); // route_id -> {route_short_name, route_long_name, route_color, route_text_color}
let tripsById = new Map();  // trip_id -> {route_id, direction_id, trip_headsign, shape_id}
let stopToTrips = new Map();// stop_id -> Set(trip_id)
let shapesById = new Map(); // shape_id -> [[lat, lon], ...]

// Selected stop
let selectedStop = null;
let selectedStopRouteSummary = null;
let signRenderToken = 0;
const tileImageCache = new Map();

const MAP_LINE_PALETTE = [
  "#e63946", "#1d3557", "#2a9d8f", "#f4a261", "#6a4c93",
  "#118ab2", "#ef476f", "#8ac926", "#ff7f11", "#3a86ff",
];

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

function initModalMap() {
  if (modalMap || !ui.modalRouteMap) return;

  modalMap = L.map(ui.modalRouteMap, {
    preferCanvas: true,
    zoomControl: true,
    attributionControl: false,
  }).setView([49.25, -123.12], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(modalMap);
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

function distance2(latA, lonA, latB, lonB) {
  const dLat = latA - latB;
  const dLon = lonA - lonB;
  return dLat * dLat + dLon * dLon;
}

function colorForIndex(idx) {
  if (idx < MAP_LINE_PALETTE.length) return MAP_LINE_PALETTE[idx];
  const hue = (idx * 47) % 360;
  return `hsl(${hue} 72% 46%)`;
}

function buildRouteSegmentsForStop(stop, items, maxRoutes) {
  const stopLat = safeParseFloat(stop.stop_lat);
  const stopLon = safeParseFloat(stop.stop_lon);
  const shown = items.slice(0, maxRoutes);
  const segments = [];
  const usedRouteShapes = new Set();

  for (const it of shown) {
    const routeShapeKey = `${it.route_id}::${it.shape_id}`;
    if (!it.shape_id || usedRouteShapes.has(routeShapeKey)) continue;
    const shape = shapesById.get(it.shape_id);
    if (!shape || shape.length < 2) continue;
    usedRouteShapes.add(routeShapeKey);

    let startIdx = 0;
    if (stopLat != null && stopLon != null) {
      let best = Infinity;
      for (let i = 0; i < shape.length; i += 1) {
        const [lat, lon] = shape[i];
        const d2 = distance2(lat, lon, stopLat, stopLon);
        if (d2 < best) {
          best = d2;
          startIdx = i;
        }
      }
    }

    if (startIdx >= shape.length - 1) startIdx = Math.max(0, shape.length - 2);
    const clipped = shape.slice(startIdx);
    if (clipped.length < 2) continue;

    segments.push({
      route_id: it.route_id,
      route_short_name: it.route_short_name || "",
      shape_id: it.shape_id,
      points: clipped,
      baseColor: normalizeColor(it.route_color, "#2b6dff"),
    });
  }

  const forceDistinct = segments.length > 1;
  for (let i = 0; i < segments.length; i += 1) {
    segments[i].lineColor = forceDistinct ? colorForIndex(i) : segments[i].baseColor;
  }

  assignParallelOffsets(segments);
  return segments;
}

function assignParallelOffsets(segments) {
  const arr = segments.slice().sort((a, b) => (a.route_short_name || "").localeCompare(b.route_short_name || ""));
  const n = arr.length;
  for (let i = 0; i < n; i += 1) {
    // Center offsets around 0: e.g. n=3 -> -6,0,+6
    arr[i].offsetPx = (i - ((n - 1) / 2)) * 6;
  }
}

function offsetPolylinePixels(pixelPoints, offsetPx) {
  if (!offsetPx || pixelPoints.length < 2) return pixelPoints.slice();
  const shifted = [];

  for (let i = 0; i < pixelPoints.length; i += 1) {
    const prev = pixelPoints[Math.max(0, i - 1)];
    const curr = pixelPoints[i];
    const next = pixelPoints[Math.min(pixelPoints.length - 1, i + 1)];

    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;

    shifted.push({
      x: curr.x + (nx * offsetPx),
      y: curr.y + (ny * offsetPx),
    });
  }

  return shifted;
}

function offsetLatLonPolylineForMap(mapObj, points, offsetPx) {
  if (!offsetPx || points.length < 2) return points;
  const zoom = mapObj.getZoom();
  const pixelPoints = points.map(([lat, lon]) => mapObj.project(L.latLng(lat, lon), zoom));
  const shifted = offsetPolylinePixels(pixelPoints, offsetPx);
  return shifted.map((p) => {
    const ll = mapObj.unproject(L.point(p.x, p.y), zoom);
    return [ll.lat, ll.lng];
  });
}

function latLonToWorld(lat, lon, zoom) {
  const s = 256 * (2 ** zoom);
  const x = ((lon + 180) / 360) * s;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - (Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI))) * s;
  return { x, y };
}

function getRouteBounds(stop, segments) {
  const stopLat = safeParseFloat(stop.stop_lat);
  const stopLon = safeParseFloat(stop.stop_lon);

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const seg of segments) {
    for (const [lat, lon] of seg.points) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  if (stopLat != null && stopLon != null) {
    if (stopLat < minLat) minLat = stopLat;
    if (stopLat > maxLat) maxLat = stopLat;
    if (stopLon < minLon) minLon = stopLon;
    if (stopLon > maxLon) maxLon = stopLon;
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) {
    return { minLat: 49.25, maxLat: 49.26, minLon: -123.12, maxLon: -123.11 };
  }
  return { minLat, maxLat, minLon, maxLon };
}

function chooseMapZoom(bounds, width, height) {
  const pad = 1.2;
  for (let z = 19; z >= 0; z -= 1) {
    const a = latLonToWorld(bounds.minLat, bounds.minLon, z);
    const b = latLonToWorld(bounds.maxLat, bounds.maxLon, z);
    const spanX = Math.abs(b.x - a.x) * pad;
    const spanY = Math.abs(b.y - a.y) * pad;
    if (spanX <= width && spanY <= height) return z;
  }
  return 0;
}

function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function loadTileImage(z, x, y) {
  const key = tileKey(z, x, y);
  if (tileImageCache.has(key)) return tileImageCache.get(key);

  const p = new Promise((resolve, reject) => {
    const n = 2 ** z;
    const tx = ((x % n) + n) % n;
    if (y < 0 || y >= n) {
      reject(new Error(`Tile y out of range: ${y}`));
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Tile load failed ${z}/${tx}/${y}`));
    img.src = `https://tile.openstreetmap.org/${z}/${tx}/${y}.png`;
  });

  tileImageCache.set(key, p);
  return p;
}

async function drawBasemapTilesOnCanvas(ctx, { x, y, w, h, bounds }) {
  const zoom = chooseMapZoom(bounds, w, h);
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const centerLon = (bounds.minLon + bounds.maxLon) / 2;
  const centerWorld = latLonToWorld(centerLat, centerLon, zoom);
  const left = centerWorld.x - (w / 2);
  const top = centerWorld.y - (h / 2);
  const right = centerWorld.x + (w / 2);
  const bottom = centerWorld.y + (h / 2);

  const x0 = Math.floor(left / 256);
  const y0 = Math.floor(top / 256);
  const x1 = Math.floor(right / 256);
  const y1 = Math.floor(bottom / 256);

  const draws = [];
  for (let tx = x0; tx <= x1; tx += 1) {
    for (let ty = y0; ty <= y1; ty += 1) {
      draws.push((async () => {
        try {
          const img = await loadTileImage(zoom, tx, ty);
          const px = x + ((tx * 256) - left);
          const py = y + ((ty * 256) - top);
          ctx.drawImage(img, px, py, 256, 256);
        } catch {
          // Best-effort tiles; continue rendering.
        }
      })());
    }
  }
  await Promise.all(draws);
}

function makeCanvasProjector(bounds, drawX, drawY, drawW, drawH) {
  const zoom = chooseMapZoom(bounds, drawW, drawH);
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const centerLon = (bounds.minLon + bounds.maxLon) / 2;
  const centerWorld = latLonToWorld(centerLat, centerLon, zoom);
  const left = centerWorld.x - (drawW / 2);
  const top = centerWorld.y - (drawH / 2);

  const project = (lat, lon) => {
    const wpt = latLonToWorld(lat, lon, zoom);
    return [drawX + (wpt.x - left), drawY + (wpt.y - top)];
  };
  return { project };
}

async function drawRoutePreviewOnCanvas(ctx, { x, y, w, h, stop, segments, renderToken }) {
  const stopLat = safeParseFloat(stop.stop_lat);
  const stopLon = safeParseFloat(stop.stop_lon);

  ctx.fillStyle = "#fafafa";
  roundRect(ctx, x, y, w, h, 14, true, false);
  ctx.strokeStyle = "#dddddd";
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 14, false, true);

  if (segments.length === 0) {
    ctx.fillStyle = "#666666";
    ctx.font = "600 19px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.fillText("No route geometry available for this stop/direction.", x + 18, y + Math.floor(h / 2));
    return;
  }

  const pad = 18;
  const legendH = 30;
  const drawX = x + pad;
  const drawY = y + pad;
  const drawW = w - (pad * 2);
  const drawH = h - (pad * 2) - legendH;
  const bounds = getRouteBounds(stop, segments);

  ctx.save();
  ctx.beginPath();
  roundRect(ctx, drawX, drawY, drawW, drawH, 10, false, false);
  ctx.clip();
  await drawBasemapTilesOnCanvas(ctx, { x: drawX, y: drawY, w: drawW, h: drawH, bounds });
  ctx.restore();

  if (renderToken !== signRenderToken) return;

  const { project } = makeCanvasProjector(bounds, drawX, drawY, drawW, drawH);

  for (const seg of segments) {
    const pixelPoints = seg.points.map(([lat, lon]) => {
      const [px, py] = project(lat, lon);
      return { x: px, y: py };
    });
    const shifted = offsetPolylinePixels(pixelPoints, seg.offsetPx || 0);

    ctx.strokeStyle = seg.lineColor;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < shifted.length; i += 1) {
      const p = shifted[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  if (stopLat != null && stopLon != null) {
    const [px, py] = project(stopLat, stopLon);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  let legendX = x + 14;
  const legendY = y + h - 12;
  ctx.font = "700 14px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  for (const seg of segments.slice(0, 6)) {
    const label = seg.route_short_name || "Route";
    const swatchW = 18;
    const textW = ctx.measureText(label).width;
    const blockW = swatchW + 8 + textW + 12;
    if (legendX + blockW > x + w - 10) break;

    ctx.fillStyle = seg.lineColor;
    roundRect(ctx, legendX, legendY - 10, swatchW, 5, 2, true, false);
    ctx.fillStyle = "#222222";
    ctx.fillText(label, legendX + swatchW + 8, legendY);
    legendX += blockW;
  }
}

function computeRouteSummaryForStop(stop, directionFilter) {
  const tripSet = stopToTrips.get(stop.stop_id);
  if (!tripSet || tripSet.size === 0) return [];

  // key -> {route_id, direction_id, count, shapeCounts, headsignCounts}
  const agg = new Map();

  for (const tripId of tripSet) {
    const t = tripsById.get(tripId);
    if (!t) continue;

    const dir = (t.direction_id === "" || t.direction_id == null) ? null : String(t.direction_id);
    if (directionFilter !== "all" && String(dir) !== String(directionFilter)) continue;

    const route = routesById.get(t.route_id);
    if (!route) continue;

    const headsign = (t.trip_headsign && String(t.trip_headsign).trim()) || (route.route_long_name || route.route_short_name || "");
    const k = `${t.route_id}||${dir ?? ""}`;
    const cur = agg.get(k) || {
      route_id: t.route_id,
      direction_id: dir,
      count: 0,
      shapeCounts: new Map(),
      headsignCounts: new Map(),
    };
    cur.count += 1;
    if (t.shape_id) {
      const prev = cur.shapeCounts.get(t.shape_id) || 0;
      cur.shapeCounts.set(t.shape_id, prev + 1);
    }
    if (headsign) {
      const prev = cur.headsignCounts.get(headsign) || 0;
      cur.headsignCounts.set(headsign, prev + 1);
    }
    agg.set(k, cur);
  }

  // Convert & sort by popularity (trip count proxy), then route number
  const items = Array.from(agg.values()).map((x) => {
    const r = routesById.get(x.route_id);
    const shortName = (r?.route_short_name ?? "").toString().trim();
    let shapeId = null;
    let shapeMax = -1;
    for (const [candidate, n] of x.shapeCounts.entries()) {
      if (n > shapeMax) {
        shapeId = candidate;
        shapeMax = n;
      }
    }
    let headsign = "";
    let headsignMax = -1;
    for (const [candidate, n] of x.headsignCounts.entries()) {
      if (n > headsignMax) {
        headsign = candidate;
        headsignMax = n;
      }
    }

    return {
      route_id: x.route_id,
      direction_id: x.direction_id,
      headsign,
      count: x.count,
      shape_id: shapeId,
      route_short_name: shortName,
      route_color: normalizeColor(r?.route_color, "#3b82f6"),
    };
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

function drawRouteMapForStop(stop, items, maxRoutes) {
  if (!ui.modalRouteMap || !stop) return;

  initModalMap();
  if (!modalMap) return;

  if (modalRouteLayer) {
    modalMap.removeLayer(modalRouteLayer);
  }
  modalRouteLayer = L.featureGroup().addTo(modalMap);

  const stopLat = safeParseFloat(stop.stop_lat);
  const stopLon = safeParseFloat(stop.stop_lon);
  const segments = buildRouteSegmentsForStop(stop, items, maxRoutes);

  if (stopLat != null && stopLon != null) {
    L.circleMarker([stopLat, stopLon], {
      radius: 6,
      weight: 2,
      color: "#111111",
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).bindTooltip(stop.stop_name || "Stop").addTo(modalRouteLayer);
  }

  const fitGroup = L.featureGroup();
  if (stopLat != null && stopLon != null) {
    fitGroup.addLayer(L.circleMarker([stopLat, stopLon], { radius: 0, opacity: 0, fillOpacity: 0 }));
  }
  for (const seg of segments) {
    fitGroup.addLayer(L.polyline(seg.points, { opacity: 0 }));
  }
  const rawBounds = fitGroup.getBounds();
  if (rawBounds && rawBounds.isValid()) {
    modalMap.fitBounds(rawBounds.pad(0.12));
  } else if (stopLat != null && stopLon != null) {
    modalMap.setView([stopLat, stopLon], 15);
  }

  for (const seg of segments) {
    const drawn = offsetLatLonPolylineForMap(modalMap, seg.points, seg.offsetPx || 0);
    L.polyline(drawn, {
      color: seg.lineColor,
      weight: 4,
      opacity: 0.9,
    }).addTo(modalRouteLayer);
  }

  if (segments.length === 0) {
    ui.modalRouteMapHint.textContent = "No route geometry available for the selected direction.";
  } else {
    ui.modalRouteMapHint.textContent = `${segments.length} route pattern${segments.length === 1 ? "" : "s"} shown from this stop onward.`;
  }

  setTimeout(() => modalMap.invalidateSize(), 0);
}

async function drawSign({ stop, items, directionFilter, maxRoutes, renderToken }) {
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

  const routeSegments = buildRouteSegmentsForStop(stop, items, maxRoutes);

  // Route map preview (this is rendered into the PNG)
  const mapTop = headerH + 24;
  const mapHeight = 300;
  ctx.fillStyle = "#111111";
  ctx.font = "800 24px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  ctx.fillText("Route map (from this stop onward)", pad, mapTop - 8);
  await drawRoutePreviewOnCanvas(ctx, {
    x: pad,
    y: mapTop + 6,
    w: W - (pad * 2),
    h: mapHeight,
    stop,
    segments: routeSegments,
    renderToken,
  });

  if (renderToken !== signRenderToken) return;

  // Route pills
  const top = mapTop + mapHeight + 64;
  const rowH = 90;
  const pillR = 34;

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
  const renderToken = ++signRenderToken;

  openModal();
  selectedStopRouteSummary = computeRouteSummaryForStop(stop, directionFilter);
  drawSign({
    stop,
    items: selectedStopRouteSummary,
    directionFilter,
    maxRoutes,
    renderToken,
  }).catch((err) => console.error("Sign render failed", err));
  drawRouteMapForStop(stop, selectedStopRouteSummary, maxRoutes);
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

  try {
    const a = document.createElement("a");
    a.download = filename;
    a.href = canvas.toDataURL("image/png");
    a.click();
  } catch (err) {
    console.error(err);
    alert("Failed to export PNG. Try again in a moment.");
  }
});

ui.copyBtn.addEventListener("click", async () => {
  const canvas = ui.signCanvas;
  if (!canvas) return;
  if (!window.ClipboardItem || !navigator.clipboard?.write) {
    alert("Copy PNG is not supported in this browser. Please use Download PNG.");
    return;
  }

  try {
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error("Failed to render PNG blob"));
      }, "image/png");
    });

    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    alert("PNG copied to clipboard.");
  } catch (err) {
    console.error(err);
    alert("Failed to copy PNG. Please use Download PNG.");
  }
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
  shapesById = new Map();
  selectedStop = null;
  selectedStopRouteSummary = null;
  if (modalRouteLayer && modalMap) {
    modalMap.removeLayer(modalRouteLayer);
    modalRouteLayer = null;
  }
  if (ui.modalRouteMapHint) ui.modalRouteMapHint.textContent = "";

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
        shape_id: (t.shape_id ?? "").toString(),
      });
    }
    ui.tripsCount.textContent = niceInt(tripsById.size);

    // 4) shapes.txt (optional) -> shape_id -> ordered [lat,lon] path
    if (zip.file("shapes.txt")) {
      setProgress(45, "Parsing shapes.txt…");
      const rawShapesById = new Map(); // shape_id -> [{lat,lon,seq}]
      await parseCSVFromZip(zip, "shapes.txt", {
        stepRow: (row) => {
          const shapeId = row.shape_id;
          if (!shapeId) return;
          const lat = safeParseFloat(row.shape_pt_lat);
          const lon = safeParseFloat(row.shape_pt_lon);
          if (lat == null || lon == null) return;
          const seq = Number.parseInt(row.shape_pt_sequence, 10);

          let pts = rawShapesById.get(shapeId);
          if (!pts) {
            pts = [];
            rawShapesById.set(shapeId, pts);
          }
          pts.push({ lat, lon, seq: Number.isFinite(seq) ? seq : pts.length });
        },
      });
      for (const [shapeId, pts] of rawShapesById.entries()) {
        pts.sort((a, b) => a.seq - b.seq);
        shapesById.set(shapeId, pts.map((p) => [p.lat, p.lon]));
      }
    } else {
      console.warn("No shapes.txt found in GTFS feed; route map overlay will be unavailable.");
    }

    // 5) stop_times.txt (large) -> build stop_id -> trip_id Set index
    setProgress(55, "Indexing stop_times.txt (stop -> trips)…");
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
          const pct = 55 + Math.min(40, (rowCount / 600000) * 40); // heuristic
          setProgress(pct, `Indexing stop_times.txt… (${niceInt(rowCount)} rows)`);
        }
      },
    });

    ui.indexCount.textContent = niceInt(stopToTrips.size);
    setProgress(98, "Rendering stops on map…");

    addStopsToMap();

    setProgress(100, "Ready. Click a stop.");
    console.log("Loaded:", {
      stops: stops.length,
      routes: routesById.size,
      trips: tripsById.size,
      shapes: shapesById.size,
      stopToTrips: stopToTrips.size,
    });
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
