/* eslint-disable no-console */
/**
 * GTFS Bus Stop Map + Sign Generator (static site)
 * - Loads google_transit.zip (or user-selected zip)
 * - Parses: stops.txt, routes.txt, trips.txt, stop_times.txt, shapes.txt, calendar*.txt
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
  downloadSvgBtn: el("downloadSvgBtn"),
  signCanvas: el("signCanvas"),
};

let map;
let markerCluster;

// GTFS data stores
let stops = [];          // [{stop_id, stop_name, stop_lat, stop_lon, stop_code?}]
let routesById = new Map(); // route_id -> {route_short_name, route_long_name, route_color, route_text_color}
let tripsById = new Map();  // trip_id -> {route_id, direction_id, trip_headsign, shape_id, service_id}
let stopToTrips = new Map();// stop_id -> Set(trip_id)
let stopTripTimes = new Map();// stop_id -> Map(trip_id -> departure seconds)
let shapesById = new Map(); // shape_id -> [[lat, lon], ...]
let serviceActiveDatesLastWeekById = new Map(); // service_id -> Set(YYYYMMDD number)
let lastWeekWeekdayByDateKey = new Map(); // YYYYMMDD number -> weekday index (0=Sun..6=Sat)
let hasServiceCalendarData = false;

// Selected stop
let selectedStop = null;
let selectedStopRouteSummary = null;
let signRenderToken = 0;
const tileImageCache = new Map();
let routeSummaryCache = new Map(); // `${stop_id}::${direction}` -> summary array
let bootGeneration = 0;

const MAP_LINE_PALETTE = [
  "#e63946", "#1d3557", "#2a9d8f", "#f4a261", "#6a4c93",
  "#118ab2", "#ef476f", "#8ac926", "#ff7f11", "#3a86ff",
];
const MAP_TILE_BASE_URL = "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png";
const MAP_TILE_LABELS_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png";
const MAP_TILE_SUBDOMAINS = "abcd";
const MAP_TILE_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO";
const SIGN_MAP_ZOOM_IN_STEPS = 1;
const SIGN_MAP_ZOOM_FIT_STEP = 0.5;
const PRELOADED_SUMMARY_URL = "./preloaded_route_summaries.json";
const STOP_TIMES_WORKER_URL = "./stop_times_worker.js";
const SHAPES_WORKER_URL = "./shapes_worker.js";

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

function parseGtfsTimeToSeconds(v) {
  if (v == null) return null;
  const raw = String(v).trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const mi = Number.parseInt(m[2], 10);
  const s = Number.parseInt(m[3] || "0", 10);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || !Number.isFinite(s)) return null;
  if (mi < 0 || mi > 59 || s < 0 || s > 59 || h < 0) return null;
  return (h * 3600) + (mi * 60) + s;
}

function dateToYmdKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return Number.parseInt(`${y}${m}${day}`, 10);
}

function parseGtfsDateKey(v) {
  if (v == null) return null;
  const raw = String(v).trim();
  if (!/^\d{8}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function getLast7DatesInfo() {
  const today = new Date();
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const out = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    out.push({ key: dateToYmdKey(d), weekday: d.getDay() });
  }
  return out;
}

function buildServiceActiveDatesLastWeek(calendarRows, calendarDateRows) {
  const weekInfo = getLast7DatesInfo();
  const weekKeys = new Set(weekInfo.map((x) => x.key));
  lastWeekWeekdayByDateKey = new Map(weekInfo.map((x) => [x.key, x.weekday]));
  const out = new Map();

  const weekdayCols = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  for (const row of calendarRows || []) {
    const sid = row.service_id;
    if (!sid) continue;
    const start = parseGtfsDateKey(row.start_date);
    const end = parseGtfsDateKey(row.end_date);
    if (start == null || end == null) continue;
    for (const w of weekInfo) {
      if (w.key < start || w.key > end) continue;
      const col = weekdayCols[w.weekday];
      if (String(row[col] || "0").trim() !== "1") continue;
      let set = out.get(sid);
      if (!set) {
        set = new Set();
        out.set(sid, set);
      }
      set.add(w.key);
    }
  }

  for (const row of calendarDateRows || []) {
    const sid = row.service_id;
    const key = parseGtfsDateKey(row.date);
    const exType = String(row.exception_type || "").trim();
    if (!sid || key == null || !weekKeys.has(key)) continue;
    let set = out.get(sid);
    if (!set) {
      set = new Set();
      out.set(sid, set);
    }
    if (exType === "1") set.add(key);
    else if (exType === "2") set.delete(key);
  }

  return out;
}

function formatClockTimeFromSeconds(sec) {
  if (!Number.isFinite(sec)) return "";
  const raw = Math.floor(sec);
  const day = 24 * 3600;
  const dayOffset = raw >= 0 ? Math.floor(raw / day) : 0;
  const t = ((raw % day) + day) % day;
  const h24 = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const h12 = ((h24 + 11) % 12) + 1;
  const ampm = h24 >= 12 ? "pm" : "am";
  const base = `${h12}:${String(m).padStart(2, "0")}${ampm}`;
  return dayOffset > 0 ? `${base}+${dayOffset}` : base;
}

function summarizeFrequencyWindows(timesSec) {
  const sorted = (timesSec || [])
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  if (sorted.length < 2) return [];

  const windows = [];
  let startIdx = 0;
  let gaps = [];

  const flushWindow = (endIdxExclusive) => {
    if (endIdxExclusive - startIdx < 2) return;
    const valid = gaps.filter((g) => g >= 2 && g <= 180);
    if (valid.length === 0) return;
    const minGap = Math.round(Math.min(...valid));
    const maxGap = Math.round(Math.max(...valid));
    const from = formatClockTimeFromSeconds(sorted[startIdx]);
    const to = formatClockTimeFromSeconds(sorted[endIdxExclusive - 1]);
    windows.push({
      from,
      to,
      minGap,
      maxGap,
    });
  };

  for (let i = 1; i < sorted.length; i += 1) {
    const gapMin = (sorted[i] - sorted[i - 1]) / 60;
    const mid = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
    const gapBreak = gapMin > 120;
    const shiftBreak = mid != null && (gapMin > (mid * 2) || gapMin < (mid / 2));
    if (gapBreak || shiftBreak) {
      flushWindow(i);
      startIdx = i;
      gaps = [];
      continue;
    }
    gaps.push(gapMin);
  }
  flushWindow(sorted.length);

  return windows;
}

function buildActiveHoursText(timesSec = []) {
  const sorted = (timesSec || [])
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  if (sorted.length === 1) return `${formatClockTimeFromSeconds(sorted[0])}`;
  return `${formatClockTimeFromSeconds(sorted[0])}-${formatClockTimeFromSeconds(sorted[sorted.length - 1])}`;
}

function dayGroupKeyFromWeekday(weekday) {
  if (weekday === 0) return "sun";
  if (weekday === 6) return "sat";
  return "monfri";
}

function buildGroupedActiveHoursText(timesByGroup, fallbackTimes = []) {
  const groups = timesByGroup || {};
  const ordered = [
    { key: "monfri", label: "Mon-Fri" },
    { key: "sat", label: "Sat" },
    { key: "sun", label: "Sun" },
  ];
  const parts = [];
  for (const g of ordered) {
    const range = buildActiveHoursText(groups[g.key] || []);
    if (!range) continue;
    parts.push(`${g.label} (${range})`);
  }
  if (parts.length > 0) return parts.join(", ");
  const fallback = buildActiveHoursText(fallbackTimes);
  return fallback ? `All days (${fallback})` : "";
}

function splitTextByMaxChars(text, maxChars) {
  const src = String(text || "").trim();
  if (!src) return [];
  const words = src.split(/\s+/);
  const out = [];
  let line = "";
  for (const w of words) {
    if (!line) {
      line = w;
      continue;
    }
    if ((line.length + 1 + w.length) <= maxChars) {
      line += ` ${w}`;
    } else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out;
}

function buildLegendLinesForSegment(seg, maxChars = 86) {
  const route = (seg?.display_name || seg?.route_short_name || "Route").toString().trim();
  const active = (seg?.active_hours_text || "").toString().trim();
  if (!active) return splitTextByMaxChars(route, maxChars);
  return splitTextByMaxChars(`${route} ${active}`.trim(), maxChars);
}

function estimateLegendHeight(segments, maxSegments = 6) {
  const use = (segments || []).slice(0, maxSegments);
  let lineCount = 0;
  for (const seg of use) lineCount += Math.max(1, buildLegendLinesForSegment(seg).length);
  const perLine = 16;
  const itemGap = 2;
  return Math.max(56, 10 + (lineCount * perLine) + (Math.max(0, use.length - 1) * itemGap));
}

function parseCSVFromZip(zip, filename, { stepRow, complete } = {}) {
  const file = zip.file(filename);
  if (!file) throw new Error(`Missing ${filename} in GTFS zip`);
  return file.async("string").then((text) => parseCSVText(text, { stepRow, complete }));
}

function parseCSVText(text, { stepRow, complete } = {}) {
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

  L.tileLayer(MAP_TILE_BASE_URL, {
    maxZoom: 19,
    subdomains: MAP_TILE_SUBDOMAINS,
    attribution: MAP_TILE_ATTRIBUTION,
  }).addTo(map);
  L.tileLayer(MAP_TILE_LABELS_URL, {
    maxZoom: 19,
    subdomains: MAP_TILE_SUBDOMAINS,
    attribution: MAP_TILE_ATTRIBUTION,
    pane: "overlayPane",
    opacity: 1,
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
  const shortNameCounts = new Map();
  for (const it of shown) {
    const short = (it?.route_short_name || "").toString().trim();
    if (!short) continue;
    shortNameCounts.set(short, (shortNameCounts.get(short) || 0) + 1);
  }
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

    const short = (it.route_short_name || "").toString().trim();
    const headsign = (it.headsign || "").toString().trim();
    let displayName = short || "Route";
    if ((shortNameCounts.get(short) || 0) > 1) {
      if (headsign) displayName = headsign;
      else if (short && it.route_id) displayName = `${short} (${it.route_id})`;
    }

    segments.push({
      route_id: it.route_id,
      overlap_route_id: routeShapeKey,
      route_short_name: short,
      headsign,
      display_name: displayName,
      active_hours_text: it.active_hours_text || buildActiveHoursText([]),
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
  for (const seg of segments) seg.offsetPx = 0;
}

function offsetPolylinePixels(pixelPoints, offsetPx) {
  if (!offsetPx || pixelPoints.length < 2) return pixelPoints.slice();

  const pts = [];
  for (const p of pixelPoints) {
    const pp = { x: p.x, y: p.y };
    if (!pts.length) {
      pts.push(pp);
      continue;
    }
    const last = pts[pts.length - 1];
    if (Math.hypot(pp.x - last.x, pp.y - last.y) > 1e-3) pts.push(pp);
  }
  if (pts.length < 2) return pts;

  const segs = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len;
    const ty = dy / len;
    segs.push({ tx, ty, nx: -ty, ny: tx });
  }

  const shifted = new Array(pts.length);
  shifted[0] = {
    x: pts[0].x + (segs[0].nx * offsetPx),
    y: pts[0].y + (segs[0].ny * offsetPx),
  };

  const maxMiter = Math.max(4, Math.abs(offsetPx) * 6);
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p = pts[i];
    const a = segs[i - 1];
    const b = segs[i];

    const ax = p.x + (a.nx * offsetPx);
    const ay = p.y + (a.ny * offsetPx);
    const bx = p.x + (b.nx * offsetPx);
    const by = p.y + (b.ny * offsetPx);

    const denom = (a.tx * b.ty) - (a.ty * b.tx);
    let ix = null;
    let iy = null;
    if (Math.abs(denom) > 1e-6) {
      const rx = bx - ax;
      const ry = by - ay;
      const t = ((rx * b.ty) - (ry * b.tx)) / denom;
      ix = ax + (a.tx * t);
      iy = ay + (a.ty * t);
      if (Math.hypot(ix - p.x, iy - p.y) > maxMiter) {
        ix = null;
        iy = null;
      }
    }

    if (ix == null || iy == null) {
      const bnx = a.nx + b.nx;
      const bny = a.ny + b.ny;
      const blen = Math.hypot(bnx, bny);
      if (blen > 1e-6) {
        ix = p.x + ((bnx / blen) * offsetPx);
        iy = p.y + ((bny / blen) * offsetPx);
      } else {
        ix = p.x + (a.nx * offsetPx);
        iy = p.y + (a.ny * offsetPx);
      }
    }

    shifted[i] = { x: ix, y: iy };
  }

  const lastIdx = pts.length - 1;
  shifted[lastIdx] = {
    x: pts[lastIdx].x + (segs[segs.length - 1].nx * offsetPx),
    y: pts[lastIdx].y + (segs[segs.length - 1].ny * offsetPx),
  };

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

function snapCoord(v) {
  return Math.round(v * 5000) / 5000;
}

function edgeKey(a, b) {
  const ka = `${snapCoord(a[0])},${snapCoord(a[1])}`;
  const kb = `${snapCoord(b[0])},${snapCoord(b[1])}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function buildSharedEdges(segments, stop = null, options = {}) {
  const segmentByRouteId = new Map();
  for (const seg of segments) {
    const rid = seg.overlap_route_id || seg.route_id;
    segmentByRouteId.set(rid, seg);
  }
  const traceOut = Array.isArray(options.traceOut) ? options.traceOut : null;
  const traceOrderOut = Array.isArray(options.traceOrderOut) ? options.traceOrderOut : null;

  const byEdge = new Map();
  for (const seg of segments) {
    const rid = seg.overlap_route_id || seg.route_id;
    for (let i = 1; i < seg.points.length; i += 1) {
      const a = seg.points[i - 1];
      const b = seg.points[i];
      const key = edgeKey(a, b);
      let e = byEdge.get(key);
      if (!e) {
        e = { key, a, b, routeIds: new Set(), colorByRoute: new Map(), firstEdgeIdxByRoute: new Map() };
        byEdge.set(key, e);
      }
      e.routeIds.add(rid);
      e.colorByRoute.set(rid, seg.lineColor);
      if (!e.firstEdgeIdxByRoute.has(rid)) e.firstEdgeIdxByRoute.set(rid, i - 1);
    }
  }

  const shared = Array.from(byEdge.values()).filter((e) => e.routeIds.size > 1);
  if (shared.length === 0) return shared;

  const nodeKeyOf = (p) => `${snapCoord(p[0])},${snapCoord(p[1])}`;
  const stopLat = stop ? safeParseFloat(stop.stop_lat) : null;
  const stopLon = stop ? safeParseFloat(stop.stop_lon) : null;

  // 1) Build connected overlap components for each route-set signature.
  const groups = new Map(); // route-set key -> edge[]
  for (const e of shared) {
    const routeSetKey = Array.from(e.routeIds).sort().join("|");
    let arr = groups.get(routeSetKey);
    if (!arr) {
      arr = [];
      groups.set(routeSetKey, arr);
    }
    arr.push(e);
  }

  const components = [];
  let nextCompId = 0;
  for (const [routeSetKey, edges] of groups.entries()) {
    const routeIds = routeSetKey.split("|");
    const nodeToEdgeIdx = new Map();
    for (let i = 0; i < edges.length; i += 1) {
      const e = edges[i];
      const na = nodeKeyOf(e.a);
      const nb = nodeKeyOf(e.b);
      if (!nodeToEdgeIdx.has(na)) nodeToEdgeIdx.set(na, []);
      if (!nodeToEdgeIdx.has(nb)) nodeToEdgeIdx.set(nb, []);
      nodeToEdgeIdx.get(na).push(i);
      nodeToEdgeIdx.get(nb).push(i);
    }

    const seen = new Set();
    for (let i = 0; i < edges.length; i += 1) {
      if (seen.has(i)) continue;
      const q = [i];
      seen.add(i);
      const compEdges = [];
      while (q.length) {
        const cur = q.pop();
        const e = edges[cur];
        compEdges.push(e);
        const na = nodeKeyOf(e.a);
        const nb = nodeKeyOf(e.b);
        const neighbors = [...(nodeToEdgeIdx.get(na) || []), ...(nodeToEdgeIdx.get(nb) || [])];
        for (const ni of neighbors) {
          if (seen.has(ni)) continue;
          seen.add(ni);
          q.push(ni);
        }
      }

      const nodeKeys = new Set();
      const nodeCoords = new Map();
      let centerLat = 0;
      let centerLon = 0;
      for (const e of compEdges) {
        const na = nodeKeyOf(e.a);
        const nb = nodeKeyOf(e.b);
        nodeKeys.add(na);
        nodeKeys.add(nb);
        if (!nodeCoords.has(na)) nodeCoords.set(na, e.a);
        if (!nodeCoords.has(nb)) nodeCoords.set(nb, e.b);
        centerLat += (e.a[0] + e.b[0]) / 2;
        centerLon += (e.a[1] + e.b[1]) / 2;
      }
      centerLat /= Math.max(1, compEdges.length);
      centerLon /= Math.max(1, compEdges.length);

      components.push({
        id: nextCompId++,
        routeSetKey,
        routeIds,
        edges: compEdges,
        edgeKeys: new Set(compEdges.map((e) => e.key)),
        nodeKeys,
        nodeCoords,
        center: [centerLat, centerLon],
        order: routeIds.slice(),
        baseScores: new Map(),
      });
    }
  }

  const compById = new Map(components.map((c) => [c.id, c]));
  const nodeToCompIds = new Map();
  for (const c of components) {
    for (const nk of c.nodeKeys) {
      if (!nodeToCompIds.has(nk)) nodeToCompIds.set(nk, new Set());
      nodeToCompIds.get(nk).add(c.id);
    }
  }

  const adj = new Map(); // compId -> Map(neiId -> Set(nodeKey))
  for (const c of components) adj.set(c.id, new Map());
  for (const [nk, idsSet] of nodeToCompIds.entries()) {
    const ids = Array.from(idsSet);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = compById.get(ids[i]);
        const b = compById.get(ids[j]);
        if (!a || !b) continue;
        const overlap = a.routeIds.filter((r) => b.routeIds.includes(r));
        if (overlap.length === 0) continue;

        if (!adj.get(a.id).has(b.id)) adj.get(a.id).set(b.id, new Set());
        if (!adj.get(b.id).has(a.id)) adj.get(b.id).set(a.id, new Set());
        adj.get(a.id).get(b.id).add(nk);
        adj.get(b.id).get(a.id).add(nk);
      }
    }
  }

  function compDist2Stop(c) {
    if (stopLat == null || stopLon == null) return 0;
    return distance2(c.center[0], c.center[1], stopLat, stopLon);
  }

  function pointSide(p, centerLon, centerLat, nx, ny) {
    return ((p[1] - centerLon) * nx) + ((p[0] - centerLat) * ny);
  }

  const boundarySampleCache = new Map();
  const boundaryContextCache = new Map();

  function collectRouteNodeContexts(comp, rid, nodeKey) {
    const cacheKey = `${comp.id}|${rid}|${nodeKey}`;
    if (boundaryContextCache.has(cacheKey)) return boundaryContextCache.get(cacheKey);

    const seg = segmentByRouteId.get(rid);
    if (!seg || !Array.isArray(seg.points) || seg.points.length < 2) {
      boundaryContextCache.set(cacheKey, []);
      return [];
    }

    const contexts = [];
    for (let i = 0; i < seg.points.length; i += 1) {
      const curr = seg.points[i];
      if (nodeKeyOf(curr) !== nodeKey) continue;

      const prev = i > 0 ? seg.points[i - 1] : null;
      const next = i < seg.points.length - 1 ? seg.points[i + 1] : null;
      const prevInComp = !!(prev && comp.edgeKeys.has(edgeKey(prev, curr)));
      const nextInComp = !!(next && comp.edgeKeys.has(edgeKey(curr, next)));
      if (!prevInComp && !nextInComp) continue;

      contexts.push({
        idx: i,
        curr,
        prev,
        next,
        prevInComp,
        nextInComp,
      });
    }

    boundaryContextCache.set(cacheKey, contexts);
    return contexts;
  }

  function collectRouteBoundarySamples(comp, rid, nodeKey) {
    const cacheKey = `${comp.id}|${rid}|${nodeKey}`;
    if (boundarySampleCache.has(cacheKey)) return boundarySampleCache.get(cacheKey);

    const contexts = collectRouteNodeContexts(comp, rid, nodeKey);
    if (contexts.length === 0) {
      boundarySampleCache.set(cacheKey, []);
      return [];
    }
    const samples = [];

    for (const ctx of contexts) {
      if (ctx.prev) {
        const transition = (!ctx.prevInComp && ctx.nextInComp) ? "merge" : "inside";
        samples.push({
          point: ctx.prev,
          outside: !ctx.prevInComp,
          transition,
          idx: ctx.idx - 1,
          nodeIdx: ctx.idx,
        });
      }
      if (ctx.next) {
        const transition = (ctx.prevInComp && !ctx.nextInComp) ? "split" : "inside";
        samples.push({
          point: ctx.next,
          outside: !ctx.nextInComp,
          transition,
          idx: ctx.idx + 1,
          nodeIdx: ctx.idx,
        });
      }
    }

    boundarySampleCache.set(cacheKey, samples);
    return samples;
  }

  function routePointNearNode(comp, rid, nodeKey, preferOutside = false) {
    const samples = collectRouteBoundarySamples(comp, rid, nodeKey);
    if (samples.length === 0) return null;

    if (preferOutside) {
      const outside = samples.find((s) => s.outside);
      if (outside) return outside.point;
    }

    const inside = samples.find((s) => !s.outside);
    if (inside) return inside.point;

    const outside = samples.find((s) => s.outside);
    if (outside) return outside.point;
    return samples[0].point;
  }

  function routeBoundaryObservation(comp, rid, nodeKey, nx, ny, options = {}) {
    const requireOutside = !!options.requireOutside;
    const preferredTransition = options.preferredTransition || null;
    const node = comp.nodeCoords.get(nodeKey);
    if (!node) return null;

    const samples = collectRouteBoundarySamples(comp, rid, nodeKey);
    if (samples.length === 0) return null;

    const eps = 1e-9;
    let best = null;
    let bestPrio = -1;
    let bestMag = -1;
    let bestIdx = Infinity;

    for (const s of samples) {
      const side = pointSide(s.point, node[1], node[0], nx, ny);
      const mag = Math.abs(side);
      if (mag < eps) continue;

      let prio = -1;
      if (s.outside && preferredTransition && s.transition === preferredTransition) prio = 7;
      else if (s.outside && s.transition === "split") prio = 5;
      else if (s.outside && s.transition === "merge") prio = 4;
      else if (s.outside) prio = 3;
      else if (!requireOutside) prio = 1;
      else prio = -1;
      if (prio < 0) continue;

      if (
        prio > bestPrio
        || (prio === bestPrio && mag > bestMag)
        || (prio === bestPrio && mag === bestMag && s.idx < bestIdx)
      ) {
        best = {
          side,
          transition: s.transition,
          idx: s.idx,
          nodeIdx: s.nodeIdx,
          outside: s.outside,
        };
        bestPrio = prio;
        bestMag = mag;
        bestIdx = s.idx;
      }
    }

    return best;
  }

  function normalFromCompAtNode(comp, nodeKey, routeHint) {
    const node = comp.nodeCoords.get(nodeKey);
    if (!node) return { nx: 0, ny: 1 };

    const candidates = (Array.isArray(routeHint) && routeHint.length)
      ? routeHint.filter((rid) => comp.routeIds.includes(rid))
      : comp.routeIds;

    let tx = 0;
    let ty = 0;
    let count = 0;
    for (const rid of candidates) {
      const contexts = collectRouteNodeContexts(comp, rid, nodeKey);
      for (const ctx of contexts) {
        // Directions are kept "from stop onward" so idx always increases downstream.
        if (ctx.prevInComp && ctx.prev) {
          tx += (ctx.curr[1] - ctx.prev[1]);
          ty += (ctx.curr[0] - ctx.prev[0]);
          count += 1;
        }
        if (ctx.nextInComp && ctx.next) {
          tx += (ctx.next[1] - ctx.curr[1]);
          ty += (ctx.next[0] - ctx.curr[0]);
          count += 1;
        }
      }
    }

    if (count === 0) {
      let anchor = null;
      for (const rid of candidates) {
        anchor = routePointNearNode(comp, rid, nodeKey, true) || routePointNearNode(comp, rid, nodeKey);
        if (anchor) break;
      }
      if (!anchor) return { nx: 0, ny: 1 };
      tx = anchor[1] - node[1];
      ty = anchor[0] - node[0];
      count = 1;
    }

    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    return { nx, ny };
  }

  function orderKey(order) {
    return order.join("|");
  }

  function lineIdForRoute(routeId) {
    const seg = segmentByRouteId.get(routeId);
    const label = (seg?.display_name ?? seg?.route_short_name ?? "").toString().trim();
    return label || String(routeId);
  }

  function computeBaseScores(comp) {
    const centerLat = comp.center[0];
    const centerLon = comp.center[1];
    let ref = comp.edges[0];
    let maxLen = 0;
    for (const e of comp.edges) {
      const dx = e.b[1] - e.a[1];
      const dy = e.b[0] - e.a[0];
      const len = Math.hypot(dx, dy);
      if (len > maxLen) {
        maxLen = len;
        ref = e;
      }
    }
    let dx = ref.b[1] - ref.a[1];
    let dy = ref.b[0] - ref.a[0];
    if (dx < 0 || (Math.abs(dx) < 1e-12 && dy < 0)) { dx = -dx; dy = -dy; }
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const scores = new Map();
    for (const rid of comp.routeIds) {
      const seg = segmentByRouteId.get(rid);
      if (!seg) { scores.set(rid, 0); continue; }
      const idxs = [];
      for (const e of comp.edges) {
        const idx = e.firstEdgeIdxByRoute.get(rid);
        if (idx != null) idxs.push(idx);
      }
      if (!idxs.length) { scores.set(rid, 0); continue; }
      idxs.sort((a, b) => a - b);
      const maxIdx = idxs[idxs.length - 1];

      let future = null;
      for (let s = maxIdx + 2; s < Math.min(seg.points.length, maxIdx + 10); s += 1) {
        const k = edgeKey(seg.points[s - 1], seg.points[s]);
        if (!comp.edgeKeys.has(k)) {
          future = seg.points[s];
          break;
        }
      }
      if (!future) future = seg.points[Math.min(seg.points.length - 1, maxIdx + 1)];
      scores.set(rid, future ? pointSide(future, centerLon, centerLat, nx, ny) : 0);
    }
    return scores;
  }

  function baseOrderForComponent(comp) {
    return comp.routeIds.slice().sort((a, b) => {
      const ds = (comp.baseScores.get(b) ?? 0) - (comp.baseScores.get(a) ?? 0);
      if (ds !== 0) return ds;
      return String(a).localeCompare(String(b));
    });
  }

  function applyEventToOrder(order, event) {
    const idx = order.indexOf(event.rid);
    if (idx < 0) return;

    if (event.side === "L") {
      for (let i = idx; i > 0; i -= 1) {
        const t = order[i - 1];
        order[i - 1] = order[i];
        order[i] = t;
      }
      return;
    }

    for (let i = idx; i < order.length - 1; i += 1) {
      const t = order[i + 1];
      order[i + 1] = order[i];
      order[i] = t;
    }
  }

  function preferredTransitionForBoundary(comp, nei) {
    const dc = compDist2Stop(comp);
    const dn = compDist2Stop(nei);
    if (!Number.isFinite(dc) || !Number.isFinite(dn)) return null;
    const eps = 1e-12;
    if (dn > dc + eps) return "split";
    if (dn < dc - eps) return "merge";
    return null;
  }

  function routeBoundaryObservationForNeighbor(comp, rid, nodeKey, nx, ny, preferredTransition = null) {
    let obs = routeBoundaryObservation(comp, rid, nodeKey, nx, ny, { requireOutside: true, preferredTransition });
    if (!obs) obs = routeBoundaryObservation(comp, rid, nodeKey, nx, ny, { requireOutside: true });
    if (!obs) obs = routeBoundaryObservation(comp, rid, nodeKey, nx, ny);
    return obs;
  }

  function boundaryInfoScore(comp, nei, nodeKey) {
    const sharedOrdered = nei.order.filter((r) => comp.routeIds.includes(r));
    const extras = comp.routeIds.filter((r) => !sharedOrdered.includes(r));
    if (extras.length === 0) return 0;

    const preferredTransition = preferredTransitionForBoundary(comp, nei);
    const { nx, ny } = normalFromCompAtNode(nei, nodeKey, sharedOrdered);
    let score = 0;
    for (const rid of extras) {
      const obs = routeBoundaryObservationForNeighbor(comp, rid, nodeKey, nx, ny, preferredTransition);
      if (!obs || !Number.isFinite(obs.side)) continue;
      const bonus = (preferredTransition && obs.transition === preferredTransition) ? 1.35 : 1;
      score += Math.abs(obs.side) * bonus;
    }
    return score;
  }

  function selectBoundaryNodes(comp, nei, nodeKeysSet) {
    const nodes = Array.from(nodeKeysSet);
    if (nodes.length <= 1) return nodes;

    const scored = nodes.map((nk) => ({ nodeKey: nk, info: boundaryInfoScore(comp, nei, nk) }));
    let candidates = scored;
    const bestInfo = scored.reduce((m, x) => Math.max(m, x.info), 0);
    if (bestInfo > 1e-9) {
      const cutoff = Math.max(1e-9, bestInfo * 0.7);
      candidates = scored.filter((x) => x.info >= cutoff);
    }

    if (stopLat != null && stopLon != null) {
      const neiUpstream = compDist2Stop(nei) <= compDist2Stop(comp);
      candidates.sort((a, b) => {
        const pa = comp.nodeCoords.get(a.nodeKey) || nei.nodeCoords.get(a.nodeKey);
        const pb = comp.nodeCoords.get(b.nodeKey) || nei.nodeCoords.get(b.nodeKey);
        const da = pa ? distance2(pa[0], pa[1], stopLat, stopLon) : Infinity;
        const db = pb ? distance2(pb[0], pb[1], stopLat, stopLon) : Infinity;
        return neiUpstream ? (da - db) : (db - da);
      });
    } else {
      candidates.sort((a, b) => {
        const pa = comp.nodeCoords.get(a.nodeKey) || nei.nodeCoords.get(a.nodeKey);
        const pb = comp.nodeCoords.get(b.nodeKey) || nei.nodeCoords.get(b.nodeKey);
        const da = pa ? distance2(pa[0], pa[1], comp.center[0], comp.center[1]) : Infinity;
        const db = pb ? distance2(pb[0], pb[1], comp.center[0], comp.center[1]) : Infinity;
        return da - db;
      });
    }

    const limit = Math.min(3, candidates.length);
    return candidates.slice(0, limit).map((x) => x.nodeKey);
  }

  function collectConstraintEvents(comp, neighborEntries) {
    const raw = [];
    const eps = 1e-9;

    for (const entry of neighborEntries) {
      const nei = entry.nei;
      const nodeKeys = Array.isArray(entry.nodeKeys) ? entry.nodeKeys : [];
      if (!nei || nodeKeys.length === 0) continue;

      const sharedOrdered = nei.order.filter((r) => comp.routeIds.includes(r));
      const extras = comp.routeIds.filter((r) => !sharedOrdered.includes(r));
      if (extras.length === 0) continue;

      const preferredTransition = preferredTransitionForBoundary(comp, nei);
      for (const nodeKey of nodeKeys) {
        const { nx, ny } = normalFromCompAtNode(nei, nodeKey, sharedOrdered);
        for (const rid of extras) {
          const obs = routeBoundaryObservationForNeighbor(comp, rid, nodeKey, nx, ny, preferredTransition);
          if (!obs || !Number.isFinite(obs.side) || Math.abs(obs.side) < eps) continue;

          const transition = (obs.transition === "merge" || obs.transition === "split")
            ? obs.transition
            : (preferredTransition || "split");

          raw.push({
            rid,
            side: obs.side > 0 ? "L" : "R",
            op: transition === "merge" ? "M" : "S",
            strength: Math.abs(obs.side),
            nodeIdx: Number.isFinite(obs.nodeIdx) ? obs.nodeIdx : Infinity,
          });
        }
      }
    }

    if (raw.length === 0) return [];

    const byRoute = new Map();
    for (const ev of raw) {
      let rec = byRoute.get(ev.rid);
      if (!rec) {
        rec = {
          rid: ev.rid,
          left: 0,
          right: 0,
          split: 0,
          merge: 0,
          strength: 0,
          firstNodeIdx: ev.nodeIdx,
        };
        byRoute.set(ev.rid, rec);
      }
      if (ev.side === "L") rec.left += ev.strength;
      else rec.right += ev.strength;
      if (ev.op === "M") rec.merge += ev.strength;
      else rec.split += ev.strength;
      rec.strength += ev.strength;
      if (ev.nodeIdx < rec.firstNodeIdx) rec.firstNodeIdx = ev.nodeIdx;
    }

    return Array.from(byRoute.values())
      .map((rec) => ({
        rid: rec.rid,
        side: rec.left >= rec.right ? "L" : "R",
        op: rec.merge >= rec.split ? "M" : "S",
        strength: rec.strength,
        firstNodeIdx: rec.firstNodeIdx,
      }))
      .sort((a, b) => {
        if (b.strength !== a.strength) return b.strength - a.strength;
        if (a.firstNodeIdx !== b.firstNodeIdx) return a.firstNodeIdx - b.firstNodeIdx;
        return String(a.rid).localeCompare(String(b.rid));
      });
  }

  function applyEventOrdering(initOrder, events) {
    const order = initOrder.slice();
    for (const ev of events) applyEventToOrder(order, ev);
    return order;
  }

  for (const c of components) {
    c.baseScores = computeBaseScores(c);
  }

  const sortedByStop = components.slice().sort((a, b) => {
    const d = compDist2Stop(a) - compDist2Stop(b);
    if (d !== 0) return d;
    return a.id - b.id;
  });

  // 2) Initial assignment using split/merge side constraints from all neighbors.
  for (const comp of sortedByStop) {
    const initOrder = baseOrderForComponent(comp);
    const neighborEntries = [];
    const nmap = adj.get(comp.id);
    if (nmap) {
      for (const [nid, nodeKeysSet] of nmap.entries()) {
        const nei = compById.get(nid);
        if (!nei) continue;
        const nodeKeys = selectBoundaryNodes(comp, nei, nodeKeysSet);
        if (nodeKeys.length === 0) continue;
        neighborEntries.push({ nei, nodeKeys });
      }
    }
    const events = collectConstraintEvents(comp, neighborEntries);
    comp.order = applyEventOrdering(initOrder, events);
  }

  // 3) Refine with all neighbors, still using event-bubble ordering.
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    const order = pass % 2 === 0 ? sortedByStop : sortedByStop.slice().reverse();
    for (const comp of order) {
      const neighborEntries = [];
      const nmap = adj.get(comp.id);
      if (nmap) {
        for (const [nid, nodeKeysSet] of nmap.entries()) {
          const nei = compById.get(nid);
          if (!nei || !nei.order?.length) continue;
          const nodeKeys = selectBoundaryNodes(comp, nei, nodeKeysSet);
          if (nodeKeys.length === 0) continue;
          neighborEntries.push({ nei, nodeKeys });
        }
      }
      if (neighborEntries.length === 0) continue;
      const events = collectConstraintEvents(comp, neighborEntries);
      if (events.length === 0) continue;
      const nextOrder = applyEventOrdering(comp.order, events);
      if (orderKey(nextOrder) !== orderKey(comp.order)) {
        comp.order = nextOrder;
        changed = true;
      }
    }
    if (!changed) break;
  }

  function sideForIndex(idx, len) {
    if (idx <= 0) return "L";
    if (idx >= len - 1) return "R";
    return idx < (len / 2) ? "L" : "R";
  }

  function buildTracePath() {
    if (!components.length) return [];
    const seed = sortedByStop
      .slice()
      .sort((a, b) => {
        const da = compDist2Stop(a);
        const db = compDist2Stop(b);
        if (da !== db) return da - db;
        if (b.order.length !== a.order.length) return b.order.length - a.order.length;
        return a.id - b.id;
      })[0];
    if (!seed) return [];

    const path = [seed];
    const visited = new Set([seed.id]);
    let cur = seed;
    const eps = 1e-12;

    while (true) {
      const nmap = adj.get(cur.id);
      if (!nmap || nmap.size === 0) break;
      const curDist = compDist2Stop(cur);
      let best = null;
      let bestScore = -Infinity;

      for (const nid of nmap.keys()) {
        if (visited.has(nid)) continue;
        const nei = compById.get(nid);
        if (!nei) continue;
        const overlap = cur.order.filter((r) => nei.routeIds.includes(r)).length;
        if (overlap === 0) continue;
        const neiDist = compDist2Stop(nei);
        const outwardBonus = neiDist >= (curDist - eps) ? 2000 : 0;
        const score = (overlap * 1000) + outwardBonus - Math.abs(neiDist - curDist);
        if (score > bestScore) {
          best = nei;
          bestScore = score;
        }
      }

      if (!best) break;
      path.push(best);
      visited.add(best.id);
      cur = best;
    }

    return path;
  }

  function appendTraceEvents() {
    const emitEvents = !!traceOut;
    const emitOrder = !!traceOrderOut;
    if (traceOut) traceOut.length = 0;
    if (traceOrderOut) traceOrderOut.length = 0;
    const path = buildTracePath();
    if (!path.length) return;

    const firstOrder = path[0].order.slice();
    const firstLineOrder = firstOrder.map((rid) => lineIdForRoute(rid));
    const traceEventsByRoute = [];
    const stepEvents = [];

    for (let i = 1; i < path.length; i += 1) {
      const prev = path[i - 1];
      const next = path[i];
      const prevOrder = prev.order.slice();
      const nextOrder = next.order.slice();
      const perStep = [];

      const splitRoutes = prevOrder.filter((rid) => !next.routeIds.includes(rid));
      splitRoutes
        .map((rid) => ({ rid, idx: prevOrder.indexOf(rid) }))
        .sort((a, b) => a.idx - b.idx)
        .forEach(({ rid, idx }) => {
          const side = sideForIndex(idx, prevOrder.length);
          const ev = { id: rid, op: "S", side };
          traceEventsByRoute.push(ev);
          perStep.push(ev);
        });

      const mergeRoutes = nextOrder.filter((rid) => !prev.routeIds.includes(rid));
      mergeRoutes
        .map((rid) => ({ rid, idx: nextOrder.indexOf(rid) }))
        .sort((a, b) => a.idx - b.idx)
        .forEach(({ rid, idx }) => {
          const side = sideForIndex(idx, nextOrder.length);
          const ev = { id: rid, op: "M", side };
          traceEventsByRoute.push(ev);
          perStep.push(ev);
        });
      stepEvents.push(perStep);
    }

    function terminalSplitSideForRoute(comp, rid, fallbackSide) {
      const eps = 1e-9;
      const nodeCandidates = [];
      for (const nodeKey of comp.nodeCoords.keys()) {
        const contexts = collectRouteNodeContexts(comp, rid, nodeKey);
        if (!contexts.length) continue;
        const splitNodeIdx = contexts
          .filter((ctx) => ctx.prevInComp && !ctx.nextInComp)
          .reduce((m, ctx) => Math.max(m, ctx.idx), -Infinity);
        if (!Number.isFinite(splitNodeIdx)) continue;
        nodeCandidates.push({ nodeKey, splitNodeIdx });
      }
      if (!nodeCandidates.length) return fallbackSide;

      nodeCandidates.sort((a, b) => b.splitNodeIdx - a.splitNodeIdx);
      const bestNode = nodeCandidates[0].nodeKey;
      const { nx, ny } = normalFromCompAtNode(comp, bestNode, comp.routeIds);

      let obs = routeBoundaryObservation(comp, rid, bestNode, nx, ny, { requireOutside: true, preferredTransition: "split" });
      if (!obs) obs = routeBoundaryObservation(comp, rid, bestNode, nx, ny, { requireOutside: true });
      if (!obs) obs = routeBoundaryObservation(comp, rid, bestNode, nx, ny);
      if (!obs || !Number.isFinite(obs.side) || Math.abs(obs.side) < eps) return fallbackSide;
      return obs.side > 0 ? "L" : "R";
    }

    function terminalSplitSideByRank(comp, routeIds) {
      const nodeCandidates = [];
      for (const rid of routeIds) {
        for (const nodeKey of comp.nodeCoords.keys()) {
          const contexts = collectRouteNodeContexts(comp, rid, nodeKey);
          if (!contexts.length) continue;
          const splitNodeIdx = contexts
            .filter((ctx) => ctx.prevInComp && !ctx.nextInComp)
            .reduce((m, ctx) => Math.max(m, ctx.idx), -Infinity);
          if (!Number.isFinite(splitNodeIdx)) continue;
          nodeCandidates.push({ nodeKey, splitNodeIdx });
        }
      }
      if (!nodeCandidates.length) return null;

      nodeCandidates.sort((a, b) => b.splitNodeIdx - a.splitNodeIdx);
      const bestNode = nodeCandidates[0].nodeKey;
      const { nx, ny } = normalFromCompAtNode(comp, bestNode, comp.routeIds);

      const observed = [];
      for (const rid of routeIds) {
        let obs = routeBoundaryObservation(comp, rid, bestNode, nx, ny, { requireOutside: true, preferredTransition: "split" });
        if (!obs) obs = routeBoundaryObservation(comp, rid, bestNode, nx, ny, { requireOutside: true });
        if (!obs) obs = routeBoundaryObservation(comp, rid, bestNode, nx, ny);
        if (!obs || !Number.isFinite(obs.side)) continue;
        observed.push({ rid, side: obs.side });
      }
      if (observed.length < 2) return null;

      observed.sort((a, b) => {
        const ds = b.side - a.side; // left-most first
        if (ds !== 0) return ds;
        return String(a.rid).localeCompare(String(b.rid));
      });

      const out = new Map();
      const n = observed.length;
      for (let i = 0; i < n; i += 1) {
        out.set(observed[i].rid, i < (n / 2) ? "L" : "R");
      }
      return out;
    }

    // Shared-overlap tracing stops at the final shared component. If multiple
    // routes are still overlapped there, represent terminal divergence by
    // splitting all but one "main" route and infer side from geometry.
    const terminalOrder = path[path.length - 1].order.slice();
    if (terminalOrder.length > 1) {
      const terminalComp = path[path.length - 1];
      const rankSides = terminalSplitSideByRank(terminalComp, terminalOrder);
      const keepIdx = Math.floor(terminalOrder.length / 2);
      const terminalSplits = terminalOrder
        .map((rid, idx) => ({ rid, idx }))
        .filter((x) => x.idx !== keepIdx)
        .sort((a, b) => {
          const da = Math.abs(a.idx - keepIdx);
          const db = Math.abs(b.idx - keepIdx);
          if (da !== db) return db - da;
          return a.idx - b.idx;
        });
      for (const { rid, idx } of terminalSplits) {
        const fallbackSide = sideForIndex(idx, terminalOrder.length);
        const side = rankSides?.get(rid) || terminalSplitSideForRoute(terminalComp, rid, fallbackSide);
        traceEventsByRoute.push({ id: rid, op: "S", side });
      }
    }

    function applyBubble(order, id, side) {
      const idx = order.indexOf(id);
      if (idx < 0) return;
      if (side === "L") {
        for (let i = idx; i > 0; i -= 1) {
          const t = order[i - 1];
          order[i - 1] = order[i];
          order[i] = t;
        }
        return;
      }
      for (let i = idx; i < order.length - 1; i += 1) {
        const t = order[i + 1];
        order[i + 1] = order[i];
        order[i] = t;
      }
    }

    function permutations(arr) {
      if (arr.length <= 1) return [arr.slice()];
      const out = [];
      for (let i = 0; i < arr.length; i += 1) {
        const head = arr[i];
        const tail = arr.slice(0, i).concat(arr.slice(i + 1));
        const tailPerms = permutations(tail);
        for (const p of tailPerms) out.push([head, ...p]);
      }
      return out;
    }

    function sequenceSwapCost(startOrder, events) {
      const sim = startOrder.slice();
      let cost = 0;
      for (const ev of events) {
        const idx = sim.indexOf(ev.id);
        if (idx < 0) continue;
        const target = ev.side === "L" ? 0 : (sim.length - 1);
        cost += Math.abs(target - idx);
        applyBubble(sim, ev.id, ev.side);
      }
      return cost;
    }

    function optimizeStartOrder(baseOrder, events) {
      if (!events.length || baseOrder.length <= 1) return baseOrder.slice();
      if (baseOrder.length <= 8) {
        let best = baseOrder.slice();
        let bestCost = sequenceSwapCost(best, events);
        const all = permutations(baseOrder);
        for (const cand of all) {
          const c = sequenceSwapCost(cand, events);
          if (c < bestCost) {
            best = cand.slice();
            bestCost = c;
          }
        }
        return best;
      }

      const rank = new Map();
      for (let i = 0; i < events.length; i += 1) {
        const ev = events[i];
        if (!rank.has(ev.id)) rank.set(ev.id, i + (ev.side === "L" ? -0.5 : 0.5));
      }
      return baseOrder.slice().sort((a, b) => {
        const ra = rank.has(a) ? rank.get(a) : 1e9;
        const rb = rank.has(b) ? rank.get(b) : 1e9;
        if (ra !== rb) return ra - rb;
        return String(a).localeCompare(String(b));
      });
    }

    const masterRouteOrder = optimizeStartOrder(firstOrder, traceEventsByRoute);
    path[0].order = masterRouteOrder.slice();

    // Keep path component orders aligned with the same event replay used for
    // trace output so rendered lane ordering matches the console order.
    const replayOrder = masterRouteOrder.slice();
    for (let i = 1; i < path.length; i += 1) {
      for (const ev of (stepEvents[i - 1] || [])) applyBubble(replayOrder, ev.id, ev.side);
      const projected = replayOrder.filter((rid) => path[i].routeIds.includes(rid));
      if (projected.length) path[i].order = projected;
    }

    const displayEvents = traceEventsByRoute.map((ev) => ({
      id: lineIdForRoute(ev.id),
      op: ev.op,
      side: ev.side,
    }));

    if (emitEvents) {
      traceOut.push({ init: firstLineOrder.slice() });
      for (const ev of displayEvents) traceOut.push({ ...ev });
    }

    if (!emitOrder) return;

    traceOrderOut.push([masterRouteOrder.map((rid) => lineIdForRoute(rid))]);

    const splitSideById = new Map(); // rid -> "L" | "R"

    function splitGroupsFromMaster(order, splitSideMap) {
      const left = [];
      const right = [];
      for (let i = 0; i < order.length; i += 1) {
        const rid = order[i];
        const side = splitSideMap.get(rid);
        if (!side) continue;
        if (side === "L") left.push({ rid, idx: i });
        else right.push({ rid, idx: i });
      }

      left.sort((a, b) => a.idx - b.idx);
      right.sort((a, b) => b.idx - a.idx);
      return [...left.map((x) => [x.rid]), ...right.map((x) => [x.rid])];
    }

    for (const ev of traceEventsByRoute) {
      applyBubble(masterRouteOrder, ev.id, ev.side);
      if (ev.op === "S") splitSideById.set(ev.id, ev.side);
      else if (ev.op === "M") splitSideById.delete(ev.id);

      const main = masterRouteOrder.filter((rid) => !splitSideById.has(rid));

      const groups = splitGroupsFromMaster(masterRouteOrder, splitSideById);
      traceOrderOut.push([
        main.map((rid) => lineIdForRoute(rid)),
        ...groups.map((group) => group.map((rid) => lineIdForRoute(rid))),
      ]);
    }
  }

  appendTraceEvents();

  function edgeDirectionForRoute(edge, rid) {
    const seg = segmentByRouteId.get(rid);
    const idx = edge.firstEdgeIdxByRoute.get(rid);
    if (!seg || idx == null || idx < 0 || idx >= seg.points.length - 1) return 0;
    const p0 = seg.points[idx];
    const p1 = seg.points[idx + 1];
    const ea = nodeKeyOf(edge.a);
    const eb = nodeKeyOf(edge.b);
    const p0k = nodeKeyOf(p0);
    const p1k = nodeKeyOf(p1);
    if (p0k === ea && p1k === eb) return 1;
    if (p0k === eb && p1k === ea) return -1;
    return 0;
  }

  for (const comp of components) {
    for (const e of comp.edges) {
      let drawDir = 0;
      const routePriority = comp.order.length ? comp.order : comp.routeIds;
      for (const rid of routePriority) {
        const dir = edgeDirectionForRoute(e, rid);
        if (dir !== 0) {
          drawDir = dir;
          break;
        }
      }
      if (drawDir < 0) {
        e.drawA = e.b;
        e.drawB = e.a;
      } else {
        e.drawA = e.a;
        e.drawB = e.b;
      }

      const ordered = comp.order.filter((rid) => e.routeIds.has(rid));
      e.orderedRouteIds = ordered.length ? ordered : Array.from(e.routeIds).sort();
    }
  }

  return shared;
}

function pointKey(p) {
  return `${snapCoord(p[0])},${snapCoord(p[1])}`;
}

function buildSharedLaneChains(sharedEdges) {
  if (!Array.isArray(sharedEdges) || sharedEdges.length === 0) return [];

  const groups = new Map();
  for (const e of sharedEdges) {
    const orderedIds = e.orderedRouteIds && e.orderedRouteIds.length
      ? e.orderedRouteIds.slice()
      : Array.from(e.routeIds).sort();
    if (orderedIds.length < 2) continue;

    const signature = orderedIds.join("|");
    let arr = groups.get(signature);
    if (!arr) {
      arr = [];
      groups.set(signature, arr);
    }
    arr.push({
      edge: e,
      orderedIds,
      colors: orderedIds.map((rid) => e.colorByRoute.get(rid)),
    });
  }

  const chains = [];

  for (const items of groups.values()) {
    const outByNode = new Map();
    const inCount = new Map();
    const outCount = new Map();

    const addNodeIfMissing = (nk) => {
      if (!inCount.has(nk)) inCount.set(nk, 0);
      if (!outCount.has(nk)) outCount.set(nk, 0);
    };

    for (let i = 0; i < items.length; i += 1) {
      const e = items[i].edge;
      const a = e.drawA || e.a;
      const b = e.drawB || e.b;
      const ak = pointKey(a);
      const bk = pointKey(b);

      addNodeIfMissing(ak);
      addNodeIfMissing(bk);

      outCount.set(ak, (outCount.get(ak) || 0) + 1);
      inCount.set(bk, (inCount.get(bk) || 0) + 1);

      if (!outByNode.has(ak)) outByNode.set(ak, []);
      outByNode.get(ak).push(i);
    }

    const visited = new Set();
    const startNodes = [];
    for (const nk of outByNode.keys()) {
      const indeg = inCount.get(nk) || 0;
      const outdeg = outCount.get(nk) || 0;
      if (indeg !== 1 || outdeg !== 1) startNodes.push(nk);
    }

    const walkFromEdge = (startEdgeIdx) => {
      if (visited.has(startEdgeIdx)) return;

      const first = items[startEdgeIdx];
      const points = [];
      let currIdx = startEdgeIdx;

      while (currIdx != null && !visited.has(currIdx)) {
        visited.add(currIdx);
        const it = items[currIdx];
        const e = it.edge;
        const a = e.drawA || e.a;
        const b = e.drawB || e.b;

        if (points.length === 0) points.push(a);
        points.push(b);

        const bk = pointKey(b);
        const outs = (outByNode.get(bk) || []).filter((idx) => !visited.has(idx));
        const indeg = inCount.get(bk) || 0;
        const outdeg = outCount.get(bk) || 0;

        if (outs.length === 1 && indeg === 1 && outdeg === 1) currIdx = outs[0];
        else currIdx = null;
      }

      if (points.length >= 2) {
        chains.push({
          points,
          orderedRouteIds: first.orderedIds.slice(),
          colors: first.colors.slice(),
        });
      }
    };

    for (const nk of startNodes) {
      const outs = outByNode.get(nk) || [];
      for (const idx of outs) walkFromEdge(idx);
    }

    // Remaining edges are simple cycles (all nodes indeg=outdeg=1).
    for (let i = 0; i < items.length; i += 1) walkFromEdge(i);
  }

  return chains;
}

function buildNonSharedRuns(points, sharedEdgeKeySet) {
  if (!Array.isArray(points) || points.length < 2) return [];
  if (!sharedEdgeKeySet || sharedEdgeKeySet.size === 0) return [points.slice()];

  const runs = [];
  let run = null;

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const isShared = sharedEdgeKeySet.has(edgeKey(a, b));

    if (isShared) {
      if (run && run.length >= 2) runs.push(run);
      run = null;
      continue;
    }

    if (!run) run = [a, b];
    else run.push(b);
  }

  if (run && run.length >= 2) runs.push(run);
  return runs;
}

function drawStripedLineOnCanvas(ctx, x1, y1, x2, y2, colors, width) {
  if (!colors || colors.length === 0) return;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;
  if (colors.length === 1) {
    ctx.strokeStyle = colors[0];
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    return;
  }

  const nx = -dy / len;
  const ny = dx / len;
  const laneStep = Math.max(2, width / colors.length);
  const laneWidth = Math.max(2, laneStep - 0.4);

  for (let i = 0; i < colors.length; i += 1) {
    const off = ((i - ((colors.length - 1) / 2)) * laneStep);
    const ox = nx * off;
    const oy = ny * off;
    ctx.strokeStyle = colors[i];
    ctx.lineWidth = laneWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1 + ox, y1 + oy);
    ctx.lineTo(x2 + ox, y2 + oy);
    ctx.stroke();
  }
}

function drawStripedLineOnMap(layer, mapObj, a, b, colors, width) {
  if (!colors || colors.length === 0) return;
  if (colors.length === 1) {
    L.polyline([a, b], {
      color: colors[0],
      weight: width,
      opacity: 1,
      lineCap: "round",
    }).addTo(layer);
    return;
  }

  const laneStep = Math.max(2, width / colors.length);
  const laneWidth = Math.max(2, laneStep - 0.4);
  for (let i = 0; i < colors.length; i += 1) {
    const off = ((i - ((colors.length - 1) / 2)) * laneStep);
    const lane = offsetLatLonPolylineForMap(mapObj, [a, b], off);
    L.polyline(lane, {
      color: colors[i],
      weight: laneWidth,
      opacity: 1,
      lineCap: "round",
    }).addTo(layer);
  }
}

function drawStripedPolylineOnCanvas(ctx, pixelPoints, colors, width, options = {}) {
  if (!Array.isArray(pixelPoints) || pixelPoints.length < 2 || !colors || colors.length === 0) return;
  const lineCap = options.lineCap || "round";
  if (colors.length === 1) {
    ctx.strokeStyle = colors[0];
    ctx.lineWidth = width;
    ctx.lineCap = lineCap;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < pixelPoints.length; i += 1) {
      const p = pixelPoints[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    return;
  }

  const laneStep = Math.max(2, width / colors.length);
  const laneWidth = Math.max(2, laneStep - 0.4);
  for (let i = 0; i < colors.length; i += 1) {
    const off = ((i - ((colors.length - 1) / 2)) * laneStep);
    const shifted = offsetPolylinePixels(pixelPoints, off);
    if (shifted.length < 2) continue;

    ctx.strokeStyle = colors[i];
    ctx.lineWidth = laneWidth;
    ctx.lineCap = lineCap;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let p = 0; p < shifted.length; p += 1) {
      if (p === 0) ctx.moveTo(shifted[p].x, shifted[p].y);
      else ctx.lineTo(shifted[p].x, shifted[p].y);
    }
    ctx.stroke();
  }
}

function drawStripedPolylineOnMap(layer, mapObj, points, colors, width, options = {}) {
  if (!Array.isArray(points) || points.length < 2 || !colors || colors.length === 0) return;
  const lineCap = options.lineCap || "round";
  if (colors.length === 1) {
    L.polyline(points, {
      color: colors[0],
      weight: width,
      opacity: 1,
      lineCap,
      lineJoin: "round",
    }).addTo(layer);
    return;
  }

  const laneStep = Math.max(2, width / colors.length);
  const laneWidth = Math.max(2, laneStep - 0.4);
  for (let i = 0; i < colors.length; i += 1) {
    const off = ((i - ((colors.length - 1) / 2)) * laneStep);
    const lane = offsetLatLonPolylineForMap(mapObj, points, off);
    L.polyline(lane, {
      color: colors[i],
      weight: laneWidth,
      opacity: 1,
      lineCap,
      lineJoin: "round",
    }).addTo(layer);
  }
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
  const fitsAtZoom = (z) => {
    const a = latLonToWorld(bounds.minLat, bounds.minLon, z);
    const b = latLonToWorld(bounds.maxLat, bounds.maxLon, z);
    const spanX = Math.abs(b.x - a.x) * pad;
    const spanY = Math.abs(b.y - a.y) * pad;
    return spanX <= width && spanY <= height;
  };

  for (let z = 19; z >= 0; z -= SIGN_MAP_ZOOM_FIT_STEP) {
    if (fitsAtZoom(z)) {
      const zoomIn = Math.min(19, z + SIGN_MAP_ZOOM_IN_STEPS);
      if (fitsAtZoom(zoomIn)) return zoomIn;
      return z;
    }
  }
  return Math.min(19, SIGN_MAP_ZOOM_IN_STEPS);
}

function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function expandTileTemplate(url, { z, x, y, subdomain = "a" }) {
  return url
    .replace("{s}", subdomain)
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y))
    .replace("{r}", "");
}

function loadTileImage(z, x, y, kind = "base") {
  const key = `${kind}/${tileKey(z, x, y)}`;
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
    const layerUrl = kind === "labels" ? MAP_TILE_LABELS_URL : MAP_TILE_BASE_URL;
    img.src = expandTileTemplate(layerUrl, { z, x: tx, y, subdomain: "a" });
  });

  tileImageCache.set(key, p);
  return p;
}

async function drawBasemapTilesOnCanvas(ctx, { x, y, w, h, bounds }) {
  const renderZoom = chooseMapZoom(bounds, w, h);
  const tileZoom = Math.max(0, Math.floor(renderZoom));
  const scale = 2 ** (renderZoom - tileZoom);
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const centerLon = (bounds.minLon + bounds.maxLon) / 2;
  const centerTileWorld = latLonToWorld(centerLat, centerLon, tileZoom);
  const centerWorld = { x: centerTileWorld.x * scale, y: centerTileWorld.y * scale };
  const left = centerWorld.x - (w / 2);
  const top = centerWorld.y - (h / 2);
  const right = centerWorld.x + (w / 2);
  const bottom = centerWorld.y + (h / 2);

  const tileSize = 256 * scale;
  const x0 = Math.floor(left / tileSize);
  const y0 = Math.floor(top / tileSize);
  const x1 = Math.floor(right / tileSize);
  const y1 = Math.floor(bottom / tileSize);

  const draws = [];
  for (let tx = x0; tx <= x1; tx += 1) {
    for (let ty = y0; ty <= y1; ty += 1) {
      draws.push((async () => {
        try {
          const img = await loadTileImage(tileZoom, tx, ty, "base");
          const px = x + ((tx * tileSize) - left);
          const py = y + ((ty * tileSize) - top);
          ctx.drawImage(img, px, py, tileSize, tileSize);
        } catch {
          // Best-effort tiles; continue rendering.
        }
      })());
    }
  }
  await Promise.all(draws);

  const labelDraws = [];
  for (let tx = x0; tx <= x1; tx += 1) {
    for (let ty = y0; ty <= y1; ty += 1) {
      labelDraws.push((async () => {
        try {
          const img = await loadTileImage(tileZoom, tx, ty, "labels");
          const px = x + ((tx * tileSize) - left);
          const py = y + ((ty * tileSize) - top);
          ctx.save();
          ctx.filter = "contrast(1.35)";
          ctx.drawImage(img, px, py, tileSize, tileSize);
          ctx.restore();
        } catch {
          // Best-effort tiles; continue rendering.
        }
      })());
    }
  }
  await Promise.all(labelDraws);
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
  const legendH = Math.min(220, estimateLegendHeight(segments, 6));
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
  const sharedEdges = buildSharedEdges(segments, stop);
  const sharedChains = buildSharedLaneChains(sharedEdges);
  const sharedEdgeKeySet = new Set(sharedEdges.map((e) => e.key));

  for (const seg of segments) {
    const runs = buildNonSharedRuns(seg.points, sharedEdgeKeySet);
    for (const run of runs) {
      const pixelPoints = run.map(([lat, lon]) => {
        const [px, py] = project(lat, lon);
        return { x: px, y: py };
      });
      if (pixelPoints.length < 2) continue;

      ctx.strokeStyle = seg.lineColor;
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < pixelPoints.length; i += 1) {
        const p = pixelPoints[i];
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  for (const chain of sharedChains) {
    const pixelPoints = chain.points.map(([lat, lon]) => {
      const [px, py] = project(lat, lon);
      return { x: px, y: py };
    });
    drawStripedPolylineOnCanvas(ctx, pixelPoints, chain.colors, 5, { lineCap: "butt" });
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

  const legendX = x + 14;
  const lineH = 16;
  const itemGap = 2;
  let legendY = y + h - legendH + 16;
  ctx.font = "700 12px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  for (const seg of segments.slice(0, 6)) {
    const lines = buildLegendLinesForSegment(seg);
    const first = lines[0] || (seg.display_name || seg.route_short_name || "Route");
    const swatchW = 18;
    ctx.fillStyle = seg.lineColor;
    roundRect(ctx, legendX, legendY - 10, swatchW, 5, 2, true, false);
    ctx.fillStyle = "#222222";
    ctx.fillText(first, legendX + swatchW + 8, legendY);
    legendY += lineH;
    for (let i = 1; i < lines.length; i += 1) {
      ctx.fillText(lines[i], legendX + swatchW + 8, legendY);
      legendY += lineH;
    }
    legendY += itemGap;
    if (legendY > y + h - 4) break;
  }
}

function computeRouteSummaryForStop(stop, directionFilter) {
  const tripSet = stopToTrips.get(stop.stop_id);
  if (!tripSet || tripSet.size === 0) return [];
  const tripTimesForStop = stopTripTimes.get(stop.stop_id) || new Map();

  // key -> {route_id, direction_id, count, shapeCounts, headsignCounts, times, timesByGroup}
  const agg = new Map();

  for (const tripId of tripSet) {
    const t = tripsById.get(tripId);
    if (!t) continue;
    const serviceDates = serviceActiveDatesLastWeekById.get(t.service_id);
    if (hasServiceCalendarData && (!serviceDates || serviceDates.size === 0)) continue;

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
      times: [],
      timesByGroup: { monfri: [], sat: [], sun: [] },
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
    const depSec = tripTimesForStop.get(tripId);
    if (depSec != null) {
      if (serviceDates && serviceDates.size > 0) {
        for (const dateKey of serviceDates) {
          const weekday = lastWeekWeekdayByDateKey.get(dateKey);
          if (weekday == null) continue;
          cur.times.push(depSec);
          const groupKey = dayGroupKeyFromWeekday(weekday);
          cur.timesByGroup[groupKey].push(depSec);
        }
      } else {
        cur.times.push(depSec);
      }
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
    const windows = summarizeFrequencyWindows(x.times);

    return {
      route_id: x.route_id,
      direction_id: x.direction_id,
      headsign,
      count: x.count,
      shape_id: shapeId,
      route_short_name: shortName,
      route_color: normalizeColor(r?.route_color, "#3b82f6"),
      frequency_windows: windows,
      active_hours_text: buildGroupedActiveHoursText(x.timesByGroup, x.times),
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

function routeSummaryCacheKey(stopId, directionFilter) {
  return `${stopId}::${directionFilter}`;
}

function loadRouteSummaryCacheFromData(preloadData) {
  if (!preloadData || typeof preloadData !== "object") return false;
  const stopsObj = preloadData.stops;
  if (!stopsObj || typeof stopsObj !== "object") return false;

  const nextCache = new Map();
  const directions = ["all", "0", "1"];
  for (const [stopId, byDirection] of Object.entries(stopsObj)) {
    if (!stopId || !byDirection || typeof byDirection !== "object") continue;
    for (const dir of directions) {
      const items = byDirection[dir];
      if (!Array.isArray(items)) continue;
      nextCache.set(routeSummaryCacheKey(stopId, dir), items);
    }
  }
  if (nextCache.size === 0) return false;
  routeSummaryCache = nextCache;
  return true;
}

async function tryLoadPreloadedRouteSummaries() {
  try {
    const res = await fetch(PRELOADED_SUMMARY_URL, { cache: "no-cache" });
    if (!res.ok) return false;
    const preloadData = await res.json();
    return loadRouteSummaryCacheFromData(preloadData);
  } catch {
    return false;
  }
}

function mapToObject(mapObj, valueMapper = (v) => v) {
  const out = {};
  for (const [k, v] of mapObj.entries()) out[k] = valueMapper(v);
  return out;
}

async function buildRouteSummariesInWorker(stopTimesBuffer, generationAtStart) {
  if (typeof Worker === "undefined") throw new Error("Worker API unavailable");

  return new Promise((resolve, reject) => {
    const worker = new Worker(STOP_TIMES_WORKER_URL);
    const cleanup = () => worker.terminate();

    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      if (generationAtStart !== bootGeneration) {
        cleanup();
        reject(new Error("Boot superseded"));
        return;
      }
      if (msg.type === "progress") {
        const rowCount = Number(msg.rowCount) || 0;
        if (rowCount > 0) {
          const pct = 55 + Math.min(40, (rowCount / 600000) * 40);
          setProgress(pct, `Indexing stop_times.txt… (${niceInt(rowCount)} rows)`);
        }
        return;
      }
      if (msg.type === "result") {
        cleanup();
        resolve(msg);
        return;
      }
      if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.error || "Worker failed"));
      }
    };
    worker.onerror = (err) => {
      cleanup();
      reject(err instanceof ErrorEvent ? new Error(err.message || "Worker runtime error") : new Error("Worker runtime error"));
    };

    worker.postMessage({
      type: "build",
      stopTimesBuffer,
      tripsById: mapToObject(tripsById),
      routesById: mapToObject(routesById),
      hasServiceCalendarData,
      serviceActiveDatesLastWeekById: mapToObject(serviceActiveDatesLastWeekById, (set) => Array.from(set)),
      lastWeekWeekdayByDateKey: mapToObject(lastWeekWeekdayByDateKey),
    }, [stopTimesBuffer]);
  });
}

async function buildShapesInWorker(shapesBuffer, generationAtStart) {
  if (typeof Worker === "undefined") throw new Error("Worker API unavailable");

  return new Promise((resolve, reject) => {
    const worker = new Worker(SHAPES_WORKER_URL);
    const cleanup = () => worker.terminate();

    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      if (generationAtStart !== bootGeneration) {
        cleanup();
        reject(new Error("Boot superseded"));
        return;
      }
      if (msg.type === "result") {
        cleanup();
        resolve(msg.shapes || {});
        return;
      }
      if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.error || "Shapes worker failed"));
      }
    };
    worker.onerror = (err) => {
      cleanup();
      reject(err instanceof ErrorEvent ? new Error(err.message || "Shapes worker runtime error") : new Error("Shapes worker runtime error"));
    };

    worker.postMessage({ type: "build", shapesBuffer }, [shapesBuffer]);
  });
}

function getRouteSummaryForStop(stop, directionFilter) {
  const key = routeSummaryCacheKey(stop.stop_id, directionFilter);
  const cached = routeSummaryCache.get(key);
  if (cached !== undefined) return cached;

  const computed = computeRouteSummaryForStop(stop, directionFilter);
  routeSummaryCache.set(key, computed);
  return computed;
}

async function preloadRouteSummariesInBackground(generationAtStart, stopsList) {
  const preloadDirections = ["all", "0", "1"];
  const preloadTotal = Math.max(1, stopsList.length * preloadDirections.length);
  let preloadDone = 0;

  for (let i = 0; i < stopsList.length; i += 1) {
    if (generationAtStart !== bootGeneration) return;
    const stop = stopsList[i];
    for (const dir of preloadDirections) {
      const key = routeSummaryCacheKey(stop.stop_id, dir);
      if (!routeSummaryCache.has(key)) {
        routeSummaryCache.set(key, computeRouteSummaryForStop(stop, dir));
      }
      preloadDone += 1;
    }

    if (i % 50 === 0) {
      // Yield to keep UI responsive and allow immediate interactions.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (generationAtStart === bootGeneration) {
    console.log(`Route summary preload complete (${niceInt(preloadDone)}/${niceInt(preloadTotal)}).`);
  }
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
  const mapY = mapTop + 6;
  const footerY = H - 40;
  const mapHeight = Math.max(220, (footerY - mapY) - 18);
  ctx.fillStyle = "#111111";
  ctx.font = "800 24px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  ctx.fillText("Route map (from this stop onward)", pad, mapTop - 8);
  await drawRoutePreviewOnCanvas(ctx, {
    x: pad,
    y: mapY,
    w: W - (pad * 2),
    h: mapHeight,
    stop,
    segments: routeSegments,
    renderToken,
  });

  if (renderToken !== signRenderToken) return;

  // Footer
  ctx.fillStyle = "#888888";
  ctx.font = "600 16px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
  ctx.fillText("Generated from GTFS • edit styles in app.js", pad, H - 40);
}

function escXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildSignSvg({ stop, items, directionFilter, maxRoutes }) {
  const W = 900;
  const H = 1200;
  const pad = 50;
  const headerH = 170;
  const mapTop = headerH + 24;
  const mapY = mapTop + 6;
  const footerY = H - 40;

  const routeSegments = buildRouteSegmentsForStop(stop, items, maxRoutes);
  const legendH = Math.min(220, estimateLegendHeight(routeSegments, 6));
  const mapHeight = Math.max(220, (footerY - mapY) - 18);
  const bounds = getRouteBounds(stop, routeSegments);
  const sharedEdges = buildSharedEdges(routeSegments, stop);
  const sharedChains = buildSharedLaneChains(sharedEdges);
  const sharedEdgeKeySet = new Set(sharedEdges.map((e) => e.key));

  const mapOuterX = pad;
  const mapOuterY = mapY;
  const mapOuterW = W - (pad * 2);
  const mapOuterH = mapHeight;
  const mapInnerPad = 18;
  const legendHForMap = legendH;
  const drawX = mapOuterX + mapInnerPad;
  const drawY = mapOuterY + mapInnerPad;
  const drawW = mapOuterW - (mapInnerPad * 2);
  const drawH = mapOuterH - (mapInnerPad * 2) - legendHForMap;
  const { project } = makeCanvasProjector(bounds, drawX, drawY, drawW, drawH);

  const renderZoom = chooseMapZoom(bounds, drawW, drawH);
  const tileZoom = Math.max(0, Math.floor(renderZoom));
  const scale = 2 ** (renderZoom - tileZoom);
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const centerLon = (bounds.minLon + bounds.maxLon) / 2;
  const centerTileWorld = latLonToWorld(centerLat, centerLon, tileZoom);
  const centerWorld = { x: centerTileWorld.x * scale, y: centerTileWorld.y * scale };
  const left = centerWorld.x - (drawW / 2);
  const top = centerWorld.y - (drawH / 2);
  const right = centerWorld.x + (drawW / 2);
  const bottom = centerWorld.y + (drawH / 2);
  const tileSize = 256 * scale;
  const x0 = Math.floor(left / tileSize);
  const y0 = Math.floor(top / tileSize);
  const x1 = Math.floor(right / tileSize);
  const y1 = Math.floor(bottom / tileSize);

  const stopLat = safeParseFloat(stop.stop_lat);
  const stopLon = safeParseFloat(stop.stop_lon);
  const stopPt = (stopLat != null && stopLon != null) ? project(stopLat, stopLon) : null;
  const subtitle = `${stop.stop_name || "—"} • ${directionFilter === "all" ? "All directions" : `Direction ${directionFilter}`}`;
  const code = stop.stop_code ? `#${stop.stop_code}` : `#${stop.stop_id}`;

  const mapClipId = "mapClip";
  const mapTileSvg = [];
  for (let tx = x0; tx <= x1; tx += 1) {
    for (let ty = y0; ty <= y1; ty += 1) {
      const n = 2 ** tileZoom;
      if (ty < 0 || ty >= n) continue;
      const txx = ((tx % n) + n) % n;
      const px = drawX + ((tx * tileSize) - left);
      const py = drawY + ((ty * tileSize) - top);
      const baseHref = expandTileTemplate(MAP_TILE_BASE_URL, { z: tileZoom, x: txx, y: ty, subdomain: "a" });
      const labelsHref = expandTileTemplate(MAP_TILE_LABELS_URL, { z: tileZoom, x: txx, y: ty, subdomain: "a" });
      mapTileSvg.push(`<image href="${baseHref}" x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${tileSize.toFixed(2)}" height="${tileSize.toFixed(2)}" opacity="0.88" />`);
      mapTileSvg.push(`<image href="${labelsHref}" x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${tileSize.toFixed(2)}" height="${tileSize.toFixed(2)}" opacity="1" />`);
    }
  }

  const routePathSvg = [];
  for (const seg of routeSegments) {
    const runs = buildNonSharedRuns(seg.points, sharedEdgeKeySet);
    for (const run of runs) {
      const d = run.map(([lat, lon], i) => {
        const [x, y] = project(lat, lon);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
      }).join(" ");
      routePathSvg.push(`<path d="${d}" fill="none" stroke="${seg.lineColor}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />`);
    }
  }

  const sharedLaneSvg = [];
  for (const chain of sharedChains) {
    if (!chain.colors || chain.colors.length <= 1 || chain.points.length < 2) continue;

    const pixelPoints = chain.points.map(([lat, lon]) => {
      const [x, y] = project(lat, lon);
      return { x, y };
    });
    const laneStep = Math.max(2, 5 / chain.colors.length);
    const laneWidth = Math.max(2, laneStep - 0.4);

    for (let i = 0; i < chain.colors.length; i += 1) {
      const off = ((i - ((chain.colors.length - 1) / 2)) * laneStep);
      const shifted = offsetPolylinePixels(pixelPoints, off);
      if (shifted.length < 2) continue;
      const d = shifted.map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
      sharedLaneSvg.push(`<path d="${d}" fill="none" stroke="${chain.colors[i]}" stroke-width="${laneWidth.toFixed(2)}" stroke-linecap="butt" stroke-linejoin="round" />`);
    }
  }

  const legendSvg = [];
  const legendX = mapOuterX + 14;
  const lineH = 16;
  const itemGap = 2;
  let legendY = mapOuterY + mapOuterH - legendHForMap + 16;
  for (const seg of routeSegments.slice(0, 6)) {
    const lines = buildLegendLinesForSegment(seg);
    const first = lines[0] || (seg.display_name || seg.route_short_name || "Route");
    legendSvg.push(`<rect x="${legendX.toFixed(2)}" y="${(legendY - 10).toFixed(2)}" width="18" height="5" rx="2" fill="${seg.lineColor}" />`);
    legendSvg.push(`<text x="${(legendX + 26).toFixed(2)}" y="${legendY.toFixed(2)}" fill="#222222" font-size="12" font-weight="700" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">${escXml(first)}</text>`);
    legendY += lineH;
    for (let i = 1; i < lines.length; i += 1) {
      legendSvg.push(`<text x="${(legendX + 26).toFixed(2)}" y="${legendY.toFixed(2)}" fill="#222222" font-size="12" font-weight="700" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">${escXml(lines[i])}</text>`);
      legendY += lineH;
    }
    legendY += itemGap;
    if (legendY > mapOuterY + mapOuterH - 4) break;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="${mapClipId}">
      <rect x="${drawX.toFixed(2)}" y="${drawY.toFixed(2)}" width="${drawW.toFixed(2)}" height="${drawH.toFixed(2)}" rx="10" />
    </clipPath>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" />
  <text x="${pad}" y="80" fill="#111111" font-size="56" font-weight="900" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">Bus Stop</text>
  <text x="${pad}" y="120" fill="#333333" font-size="28" font-weight="700" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">${escXml(code)}</text>
  <rect x="${W - pad - 110}" y="35" width="110" height="110" rx="18" fill="#2b6dff" />
  <text x="${W - pad - 55}" y="109" text-anchor="middle" fill="#ffffff" font-size="72" font-weight="900" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">T</text>
  <text x="${pad}" y="${headerH}" fill="#666666" font-size="22" font-weight="600" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">${escXml(subtitle)}</text>
  <text x="${pad}" y="${mapTop - 8}" fill="#111111" font-size="24" font-weight="800" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">Route map (from this stop onward)</text>
  <rect x="${mapOuterX}" y="${mapOuterY}" width="${mapOuterW}" height="${mapOuterH}" rx="14" fill="#fafafa" stroke="#dddddd" />
  <g clip-path="url(#${mapClipId})">
    ${mapTileSvg.join("")}
  </g>
  ${routePathSvg.join("")}
  ${sharedLaneSvg.join("")}
  ${stopPt ? `<circle cx="${stopPt[0].toFixed(2)}" cy="${stopPt[1].toFixed(2)}" r="6" fill="#ffffff" stroke="#111111" stroke-width="2" />` : ""}
  ${legendSvg.join("")}
  <text x="${pad}" y="${H - 40}" fill="#888888" font-size="16" font-weight="600" font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial">Generated from GTFS • edit styles in app.js</text>
</svg>`;
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
  selectedStopRouteSummary = getRouteSummaryForStop(stop, directionFilter);
  const debugSegments = buildRouteSegmentsForStop(stop, selectedStopRouteSummary, maxRoutes);
  const overlapEvents = [];
  const overlapOrder = [];
  buildSharedEdges(debugSegments, stop, { traceOut: overlapEvents, traceOrderOut: overlapOrder });
  console.log("Shared route ordering events", {
    stop_id: stop.stop_id,
    stop_code: stop.stop_code || null,
    stop_name: stop.stop_name || "",
    direction_filter: directionFilter,
    max_routes: maxRoutes,
    events: overlapEvents,
    order: overlapOrder,
  });

  drawSign({
    stop,
    items: selectedStopRouteSummary,
    directionFilter,
    maxRoutes,
    renderToken,
  }).catch((err) => console.error("Sign render failed", err));
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

ui.downloadSvgBtn.addEventListener("click", () => {
  const stop = selectedStop;
  if (!stop) return;

  const directionFilter = ui.directionSelect.value || "all";
  const maxRoutes = Math.max(4, Math.min(20, parseInt(ui.maxRoutes.value || "6", 10)));
  const items = getRouteSummaryForStop(stop, directionFilter);
  const svg = buildSignSvg({ stop, items, directionFilter, maxRoutes });

  const name = (stop.stop_name || "bus_stop").toString().replace(/[^\w\-]+/g, "_").slice(0, 50);
  const code = (stop.stop_code || stop.stop_id || "").toString().replace(/[^\w\-]+/g, "_").slice(0, 30);
  const filename = `${name}_${code}_dir-${directionFilter}.svg`;

  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.download = filename;
    a.href = url;
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
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
  bootGeneration += 1;
  const generationAtStart = bootGeneration;
  setProgress(2, "Loading GTFS zip…");
  ui.zipName.textContent = zipName;

  // Clear previous data
  stops = [];
  routesById = new Map();
  tripsById = new Map();
  stopToTrips = new Map();
  stopTripTimes = new Map();
  shapesById = new Map();
  serviceActiveDatesLastWeekById = new Map();
  lastWeekWeekdayByDateKey = new Map();
  hasServiceCalendarData = false;
  selectedStop = null;
  selectedStopRouteSummary = null;
  routeSummaryCache = new Map();

  try {
    const zip = zipFile ? await loadZipFromFile(zipFile) : await loadZipFromUrl(zipUrl);
    const canUsePreloadedSummaries = !zipFile && zipName === "google_transit.zip";
    const preloadPromise = canUsePreloadedSummaries ? tryLoadPreloadedRouteSummaries() : Promise.resolve(false);

    // 1) stops.txt (small-ish)
    setProgress(10, "Parsing stops.txt…");
    stops = await parseCSVFromZip(zip, "stops.txt");
    ui.stopsCount.textContent = niceInt(stops.length);
    if (generationAtStart !== bootGeneration) return;

    // 2) start shapes parsing in worker so it can overlap with later GTFS steps.
    let shapesReady = false;
    const shapesFile = zip.file("shapes.txt");
    const shapesPromise = (async () => {
      if (!shapesFile) {
        console.warn("No shapes.txt found in GTFS feed; route map overlay will be unavailable.");
        shapesReady = true;
        return;
      }

      try {
        const shapesBuffer = await shapesFile.async("arraybuffer");
        const shapesObj = await buildShapesInWorker(shapesBuffer, generationAtStart);
        if (generationAtStart !== bootGeneration) return;
        shapesById = new Map();
        for (const [shapeId, points] of Object.entries(shapesObj || {})) {
          if (!Array.isArray(points) || points.length < 2) continue;
          shapesById.set(shapeId, points);
        }
      } catch (err) {
        console.warn("Shapes worker unavailable, falling back to main thread parsing.", err);
        const rawShapesById = new Map();
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
        if (generationAtStart !== bootGeneration) return;
        shapesById = new Map();
        for (const [shapeId, pts] of rawShapesById.entries()) {
          pts.sort((a, b) => a.seq - b.seq);
          shapesById.set(shapeId, pts.map((p) => [p.lat, p.lon]));
        }
      } finally {
        shapesReady = true;
      }
    })();
    void shapesPromise.catch(() => {});

    // 3) fast path: if preloaded summaries exist, skip trips/routes/calendar/stop_times parsing.
    setProgress(35, "Loading precomputed route summaries…");
    const preloadedLoaded = await preloadPromise;
    if (generationAtStart !== bootGeneration) return;
    if (preloadedLoaded) {
      setProgress(45, "Finishing shapes…");
      await shapesPromise;
      if (generationAtStart !== bootGeneration) return;
      ui.routesCount.textContent = "Preloaded";
      ui.tripsCount.textContent = "Preloaded";
      ui.indexCount.textContent = "Preloaded";
      setProgress(98, "Rendering stops on map…");
      addStopsToMap();
      setProgress(100, "Ready. Click a stop.");
      console.log("Loaded with precomputed route summaries.");
      return;
    }

    // 4) routes + trips + calendar (required for worker summary build)
    setProgress(40, "Parsing routes.txt…");
    const routes = await parseCSVFromZip(zip, "routes.txt");
    for (const r of routes) routesById.set(r.route_id, r);
    ui.routesCount.textContent = niceInt(routesById.size);
    if (generationAtStart !== bootGeneration) return;

    setProgress(48, "Parsing trips.txt…");
    const trips = await parseCSVFromZip(zip, "trips.txt");
    for (const t of trips) {
      tripsById.set(t.trip_id, {
        route_id: t.route_id,
        direction_id: (t.direction_id ?? "").toString(),
        trip_headsign: t.trip_headsign ?? "",
        shape_id: (t.shape_id ?? "").toString(),
        service_id: (t.service_id ?? "").toString(),
      });
    }
    ui.tripsCount.textContent = niceInt(tripsById.size);
    if (generationAtStart !== bootGeneration) return;

    setProgress(53, "Parsing service calendar…");
    let calendarRows = [];
    let calendarDateRows = [];
    if (zip.file("calendar.txt")) calendarRows = await parseCSVFromZip(zip, "calendar.txt");
    if (zip.file("calendar_dates.txt")) calendarDateRows = await parseCSVFromZip(zip, "calendar_dates.txt");
    hasServiceCalendarData = calendarRows.length > 0 || calendarDateRows.length > 0;
    if (hasServiceCalendarData) {
      serviceActiveDatesLastWeekById = buildServiceActiveDatesLastWeek(calendarRows, calendarDateRows);
    }
    if (generationAtStart !== bootGeneration) return;

    // 5) stop_times worker path first (multithreaded)
    setProgress(55, "Indexing stop_times.txt…");
    const stopTimesFile = zip.file("stop_times.txt");
    if (!stopTimesFile) throw new Error("Missing stop_times.txt in GTFS zip");
    const stopTimesBuffer = await stopTimesFile.async("arraybuffer");
    if (generationAtStart !== bootGeneration) return;

    let workerLoaded = false;
    try {
      const msg = await buildRouteSummariesInWorker(stopTimesBuffer, generationAtStart);
      if (msg?.type === "result" && loadRouteSummaryCacheFromData(msg.data)) {
        workerLoaded = true;
        const workerStopCount = Number(msg.stopCount);
        ui.indexCount.textContent = Number.isFinite(workerStopCount) ? niceInt(workerStopCount) : "Worker";
      }
    } catch (err) {
      console.warn("Worker summary build unavailable, falling back to main thread indexing.", err);
    }
    if (generationAtStart !== bootGeneration) return;

    if (!workerLoaded) {
      const stopTimesText = await stopTimesFile.async("string");
      let rowCount = 0;
      await parseCSVText(stopTimesText, {
        stepRow: (row) => {
          rowCount += 1;
          const stopId = row.stop_id;
          const tripId = row.trip_id;
          if (!stopId || !tripId) return;

          let set = stopToTrips.get(stopId);
          if (!set) { set = new Set(); stopToTrips.set(stopId, set); }
          set.add(tripId);

          const depSec = parseGtfsTimeToSeconds(row.departure_time) ?? parseGtfsTimeToSeconds(row.arrival_time);
          if (depSec != null) {
            let byTrip = stopTripTimes.get(stopId);
            if (!byTrip) {
              byTrip = new Map();
              stopTripTimes.set(stopId, byTrip);
            }
            const prev = byTrip.get(tripId);
            if (prev == null || depSec < prev) byTrip.set(tripId, depSec);
          }

          if (rowCount % 50000 === 0) {
            const pct = 55 + Math.min(40, (rowCount / 600000) * 40);
            setProgress(pct, `Indexing stop_times.txt… (${niceInt(rowCount)} rows)`);
          }
        },
      });

      ui.indexCount.textContent = niceInt(stopToTrips.size);
    }

    if (!shapesReady) {
      setProgress(96, "Finalizing shapes…");
      await shapesPromise;
      if (generationAtStart !== bootGeneration) return;
    }

    setProgress(98, "Rendering stops on map…");

    addStopsToMap();

    setProgress(100, "Ready. Click a stop.");
    if (!workerLoaded && routeSummaryCache.size === 0) {
      setTimeout(() => {
        void preloadRouteSummariesInBackground(generationAtStart, stops.slice());
      }, 0);
    }
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
