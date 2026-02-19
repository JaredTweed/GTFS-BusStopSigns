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
  topProgress: el("topProgress"),
  topProgressBar: el("topProgressBar"),
  topProgressText: el("topProgressText"),
  reloadBtn: el("reloadBtn"),
  updatesStatus: el("updatesStatus"),
  gtfsFile: el("gtfsFile"),
  modal: el("modal"),
  modalBackdrop: el("modalBackdrop"),
  closeModal: el("closeModal"),
  modalTitle: el("modalTitle"),
  modalSubtitle: el("modalSubtitle"),
  downloadBtn: el("downloadBtn"),
  copyBtn: el("copyBtn"),
  downloadSvgBtn: el("downloadSvgBtn"),
  massSelectRegionBtn: el("massSelectRegionBtn"),
  massDownloadFormat: el("massDownloadFormat"),
  massDownloadBtn: el("massDownloadBtn"),
  massCancelBtn: el("massCancelBtn"),
  massSelectionCount: el("massSelectionCount"),
  massDownloadStatus: el("massDownloadStatus"),
  showStopsToggle: el("showStopsToggle"),
  showStopsToggleLabel: el("showStopsToggleLabel"),
  modalBody: el("modalBody"),
  signWrap: el("signWrap"),
  signCanvas: el("signCanvas"),
};

let map;
let markerCluster;

// GTFS data stores
let stops = [];          // [{stop_id, stop_name, stop_lat, stop_lon, stop_code?}]
let stopsById = new Map(); // stop_id -> stop row
let routesById = new Map(); // route_id -> {route_short_name, route_long_name, route_color, route_text_color}
let tripsById = new Map();  // trip_id -> {route_id, direction_id, trip_headsign, shape_id, service_id}
let stopToTrips = new Map();// stop_id -> Set(trip_id)
let stopTripTimes = new Map();// stop_id -> Map(trip_id -> departure seconds)
let shapesById = new Map(); // shape_id -> [[lat, lon], ...]
let serviceActiveWeekdaysById = new Map(); // service_id -> Set(weekday index, 0=Sun..6=Sat)
let hasServiceCalendarData = false;
let useTransLinkStopScheduleUrl = false;

// Selected stop
let selectedStop = null;
let selectedStopRouteSummary = null;
let signRenderToken = 0;
const tileImageCache = new Map();
const headerQrCodeDataUrlCache = new Map();
const sourceImageCache = new Map();
let routeSummaryCache = new Map(); // `${stop_id}::${direction}` -> summary array
let preloadedStopOverlayByStop = new Map(); // stop_id -> Map(route_id::shape_id -> [downstream_stop_id...])
let showStopsOnSign = true;
let useCenteredQrMapUrl = true;
let activeZip = null;
let bootGeneration = 0;
let feedUpdatedDateLabel = "";
let feedUpdatedDateKey = null;
let usingPreloadedSummaries = false;
let tripIndexReady = false;
let candidateTripsByRouteShapeDirectionHeadsign = new Map();
let candidateTripsByRouteShapeDirection = new Map();
let candidateTripsByRouteShape = new Map();
let tripStopsByTripId = new Map(); // trip_id -> [stop_id... in stop_sequence order]
let routeStopsOverlayCache = new Map(); // stop_id + segment signature -> Map(route_shape_key -> marker[])
let stopOverlayWorker = null;
let stopOverlayWorkerReady = false;
let stopOverlayWorkerInitPromise = null;
let stopOverlayWorkerRequestSeq = 0;
let stopOverlayWorkerPending = new Map(); // req_id -> {resolve, reject}

const MAP_LINE_PALETTE = [
  "#e63946", "#1d3557", "#2a9d8f", "#f4a261", "#6a4c93",
  "#118ab2", "#ef476f", "#8ac926", "#ff7f11", "#3a86ff",
];
const MAP_TILE_BASE_URL = "https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png";
const MAP_TILE_LABELS_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png";
const MAP_TILE_SUBDOMAINS = "abcd";
const MAP_TILE_ATTRIBUTION = "&copy; OpenStreetMap contributors &copy; CARTO";
const SIGN_MAP_ZOOM_IN_STEPS = 1;
const SIGN_MAP_ZOOM_FIT_STEP = 0.2;
const SIGN_BASEMAP_TILE_ZOOM_OFFSET = 4;
const SIGN_VECTOR_STYLE_URL = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const SIGN_VECTOR_ROAD_LABEL_SIZE_SCALE = 10;
const SIGN_VECTOR_ROAD_LABEL_DENSITY_SCALE = 0.1;
const SIGN_VECTOR_ROAD_LABEL_MINZOOM_SHIFT = -10;
const SIGN_VECTOR_ROAD_LABEL_REFERENCE_ZOOM = 16.6;
const SIGN_VECTOR_ROAD_LABEL_ZOOM_COMPENSATION = 1;
const SIGN_VECTOR_ROAD_LABEL_MIN_FACTOR = 0.55;
const SIGN_VECTOR_ROAD_LABEL_MAX_FACTOR = 1.45;
const SIGN_VECTOR_ROAD_LABEL_COLOR = "#4b5563";
const SIGN_VECTOR_ROAD_LABEL_HALO_COLOR = "#ffffff";
const SIGN_VECTOR_ROAD_LABEL_HALO_WIDTH = 1.2;
const SIGN_VECTOR_NON_ROAD_LABEL_SIZE_SCALE = 1.48;
const SIGN_VECTOR_GL_ZOOM_OFFSET = -1;
const SIGN_BASEMAP_OPACITY = 0.86;
const SIGN_TEMPLATE = Object.freeze({
  size: Object.freeze({
    width: 900,
    height: 1200,
  }),
  spacing: Object.freeze({
    outerPad: 50,
  }),
  labels: Object.freeze({
    title: "Bus Stop",
    mapTitle: "Route map (from this stop onward)",
    qrFallback: "QR",
    qrCaptionLines: Object.freeze([
      "Scan for arrival times",
    ]),
  }),
  header: Object.freeze({
    height: 180,
    titleBaselineY: 80,
    codeBaselineY: 120,
    subtitleBaselineY: 180,
    qrY: 32,
    qrSize: 120,
    qrFramePad: 6,
    qrFrameRadius: 12,
    qrFrameStrokeWidth: 2,
    qrCaptionTopOffset: 20,
    qrCaptionLineHeight: 16,
    qrFallbackRadius: 10,
    qrFallbackLabelYOffset: 8,
  }),
  map: Object.freeze({
    sectionTopOffset: 30,
    titleBaselineOffset: -8,
    outerTopOffset: 6,
    outerBottomGapFromFooter: 18,
    outerMinHeight: 220,
    outerRadius: 14,
    outerFill: "#fafafa",
    outerStroke: "#dddddd",
    noRouteMessageXOffset: 18,
    innerPad: 18,
    clipRadius: 10,
  }),
  footer: Object.freeze({
    baselineInset: 40,
  }),
  legend: Object.freeze({
    maxItems: Number.POSITIVE_INFINITY,
    maxHeight: 220,
    lineHeight: 16,
    itemGap: 2,
    startBaselineOffset: 16,
    xInset: 14,
    swatchWidth: 18,
    swatchHeight: 5,
    swatchRadius: 2,
    swatchTopOffset: 10,
    textGap: 8,
    maxInlineChars: 116,
    bottomGuard: 4,
  }),
  marker: Object.freeze({
    stopRadius: 6,
    stopStrokeWidth: 2,
  }),
  colors: Object.freeze({
    title: "#111111",
    code: "#333333",
    subtitle: "#666666",
    qrCaption: "#4b5563",
    qrFallbackBg: "#eef2ff",
    qrFallbackText: "#1e3a8a",
    qrFrameFill: "#ffffff",
    qrFrameStroke: "#111111",
    mapTitle: "#111111",
    footer: "#888888",
    legendText: "#222222",
    noRouteMessage: "#666666",
    stopMarkerFill: "#ffffff",
    stopMarkerStroke: "#111111",
  }),
  typography: Object.freeze({
    family: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
    title: Object.freeze({ weight: 900, size: 56 }),
    code: Object.freeze({ weight: 700, size: 28 }),
    subtitle: Object.freeze({ weight: 600, size: 22 }),
    mapTitle: Object.freeze({ weight: 800, size: 24 }),
    qrCaption: Object.freeze({ weight: 600, size: 12 }),
    qrFallback: Object.freeze({ weight: 900, size: 24 }),
    footer: Object.freeze({ weight: 600, size: 16 }),
    legendBold: Object.freeze({ weight: 700, size: 12 }),
    legendRegular: Object.freeze({ weight: 400, size: 12 }),
    noRouteMessage: Object.freeze({ weight: 600, size: 19 }),
  }),
  qrExportSize: 512,
});
const SIGN_ROUTE_LINE_WIDTH_RULES = [
  { minGroupCount: 7, width: 30 },
  { minGroupCount: 6, width: 25 },
  { minGroupCount: 5, width: 20 },
  { minGroupCount: 4, width: 15 },
  { minGroupCount: 3, width: 13 },
  { minGroupCount: 2, width: 10 },
  { minGroupCount: 0, width: 5 },
];
const SIGN_ROUTE_GROUP_SIMPLIFY_TOLERANCE_PX = 0;
const SIGN_ROUTE_GROUP_LANE_OVERLAP_PX = 0.45;
const SIGN_ROUTE_CONTINUITY_SMOOTHNESS_PX = 10;
const SIGN_ROUTE_CONTINUITY_SAMPLE_STEP_PX = 1.2;
const SIGN_ROUTE_CORNER_TRIANGLE_REMOVE_MAX_PX = 50;
const STOP_OVERLAY_TRIP_CANDIDATE_LIMIT = 24;
const PRELOADED_SUMMARY_URL = "./preloaded_route_summaries.json";
const PRELOADED_SUMMARY_MIN_VERSION = 5;
const PRELOADED_SUMMARY_COMPACT_ITEM_FIELDS = [
  "route_id",
  "direction_id",
  "headsign",
  "count",
  "shape_id",
  "route_short_name",
  "route_color",
  "active_hours_text",
];
const STOP_TIMES_WORKER_URL = "./stop_times_worker.js";
const STOP_OVERLAY_WORKER_URL = "./stop_overlay_worker.js";
const SHAPES_WORKER_URL = "./shapes_worker.js";
const TRANSLINK_LATEST_GTFS_URL = "https://gtfs-static.translink.ca/gtfs/google_transit.zip";
const CONTRIBUTION_URL_FALLBACK = "https://jaredtweed.github.io/GTFS-BusStopSigns/";
const FIXED_DIRECTION_FILTER = "all";
const FIXED_EXPORT_SCALE = 3;
const QR_URL_MODE_TOGGLE_KEY = "KeyY";
const TOUCH_STOP_MARKER_STYLE = Object.freeze({
  radius: 8,
  weight: 1.5,
  fillOpacity: 0.9,
});
const DEFAULT_STOP_MARKER_STYLE = Object.freeze({
  radius: 4,
  weight: 1,
  fillOpacity: 0.85,
});
const TOUCH_MAP_TAP_TOLERANCE = 30;
const DEFAULT_MAP_TAP_TOLERANCE = 15;
const TOUCH_CANVAS_TOLERANCE = 10;
const DEFAULT_CANVAS_TOLERANCE = 0;
const DIRECTION_PREFIX_BY_WORD = new Map([
  ["eastbound", "EB"],
  ["westbound", "WB"],
  ["northbound", "NB"],
  ["southbound", "SB"],
]);
const PREVIEW_ZOOM_MIN = 1;
const PREVIEW_ZOOM_MAX = 5;
const PREVIEW_ZOOM_STEP = 1.12;
const EXPORT_MAX_RENDER_ATTEMPTS = 8;
const EXPORT_RETRY_DELAYS_MS = Object.freeze([120, 200, 320, 500, 760, 1100, 1500, 2000]);
const MASS_SELECT_DRAG_MIN_PX = 8;
let previewZoomScale = 1;
let previewZoomOriginX = 50;
let previewZoomOriginY = 50;
let signVectorStylePromise = null;
let signVectorMapHost = null;
let signVectorMap = null;
let signVectorUnavailable = false;
let signVectorRoadLabelBaseSizeByLayer = new Map();
let signVectorRoadLabelLastFactor = null;
let progressTargetPct = 0;
let progressRenderedPct = 0;
let progressAnimationFrame = 0;
let exportJobInProgress = false;
let massSelectionMode = false;
let massSelectionDragState = null;
let massSelectionOverlay = null;
let massSelectionRectEl = null;
let massSelectionLayer = null;
let massSelectionBounds = null;
let massSelectedStops = [];
let activeMassDownloadCancelToken = null;
let massSelectionMapHandlerState = null;

function isCoarsePointerDevice() {
  if (typeof window === "undefined") return false;
  const media = window.matchMedia?.("(pointer: coarse)");
  if (media && media.matches) return true;
  const touchPoints = Number(navigator?.maxTouchPoints || 0);
  return touchPoints > 0;
}

function stopMarkerStyle() {
  return isCoarsePointerDevice() ? TOUCH_STOP_MARKER_STYLE : DEFAULT_STOP_MARKER_STYLE;
}

function applyPreviewZoom() {
  if (!ui.signCanvas) return;
  ui.signCanvas.style.transformOrigin = `${previewZoomOriginX}% ${previewZoomOriginY}%`;
  ui.signCanvas.style.transform = `scale(${previewZoomScale})`;
}

function resetPreviewZoom() {
  previewZoomScale = 1;
  previewZoomOriginX = 50;
  previewZoomOriginY = 50;
  applyPreviewZoom();
}

function clampPreviewZoom(v) {
  return Math.max(PREVIEW_ZOOM_MIN, Math.min(PREVIEW_ZOOM_MAX, v));
}

function onSignPreviewWheel(e) {
  if (!ui.modal || ui.modal.classList.contains("hidden")) return;
  // Keep normal wheel scroll behavior unless the user explicitly requests zoom.
  if (!e.ctrlKey && !e.metaKey) return;
  const rect = ui.signCanvas?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
  e.preventDefault();
  const relX = (e.clientX - rect.left) / rect.width;
  const relY = (e.clientY - rect.top) / rect.height;
  previewZoomOriginX = Math.max(0, Math.min(100, relX * 100));
  previewZoomOriginY = Math.max(0, Math.min(100, relY * 100));
  const zoomFactor = e.deltaY < 0 ? PREVIEW_ZOOM_STEP : (1 / PREVIEW_ZOOM_STEP);
  const next = clampPreviewZoom(previewZoomScale * zoomFactor);
  if (Math.abs(next - previewZoomScale) < 1e-4) return;
  previewZoomScale = next;
  applyPreviewZoom();
}

function getSignCanvasPointFromMouseEvent(ev) {
  const canvas = ui.signCanvas;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const relX = (ev.clientX - rect.left) / rect.width;
  const relY = (ev.clientY - rect.top) / rect.height;
  if (!Number.isFinite(relX) || !Number.isFinite(relY)) return null;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null;
  return {
    x: relX * canvas.width,
    y: relY * canvas.height,
  };
}

function isCanvasPointInsideQrArea(canvasPoint) {
  if (!canvasPoint || !selectedStop) return false;
  const canvas = ui.signCanvas;
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return false;
  const qrLayout = getSignLayoutGeometry({
    width: SIGN_TEMPLATE.size.width,
    height: SIGN_TEMPLATE.size.height,
  }).qrLayout;
  const scaleX = canvas.width / SIGN_TEMPLATE.size.width;
  const scaleY = canvas.height / SIGN_TEMPLATE.size.height;
  const tolerance = isCoarsePointerDevice() ? TOUCH_CANVAS_TOLERANCE : DEFAULT_CANVAS_TOLERANCE;
  const x = canvasPoint.x / scaleX;
  const y = canvasPoint.y / scaleY;
  return (
    x >= (qrLayout.frameX - tolerance)
    && x <= (qrLayout.frameX + qrLayout.frameSize + tolerance)
    && y >= (qrLayout.frameY - tolerance)
    && y <= (qrLayout.frameY + qrLayout.frameSize + tolerance)
  );
}

function updateSignCanvasCursor(ev) {
  const canvas = ui.signCanvas;
  if (!canvas) return;
  if (!ui.modal || ui.modal.classList.contains("hidden")) {
    canvas.style.cursor = "";
    return;
  }
  const point = getSignCanvasPointFromMouseEvent(ev);
  canvas.style.cursor = isCanvasPointInsideQrArea(point) ? "pointer" : "";
}

function onSignCanvasClick(ev) {
  if (!ui.modal || ui.modal.classList.contains("hidden")) return;
  const stop = selectedStop;
  if (!stop) return;
  const point = getSignCanvasPointFromMouseEvent(ev);
  if (!isCanvasPointInsideQrArea(point)) return;
  const targetUrl = buildGoogleMapsStopUrl(stop);
  if (!targetUrl) return;
  window.open(targetUrl, "_blank", "noopener,noreferrer");
}

function setProgress(pct, text) {
  const clampedPct = Math.max(0, Math.min(100, pct));
  const message = String(text ?? "");
  progressTargetPct = clampedPct;
  ui.progressText.textContent = message;
  if (ui.topProgressText) ui.topProgressText.textContent = message;

  const lower = message.trim().toLowerCase();
  const isReady = lower.startsWith("ready.");
  const isError = lower.startsWith("error:");
  const showTopProgress = (clampedPct < 100 && !isReady) || isError;
  if (ui.topProgress) ui.topProgress.classList.toggle("hidden", !showTopProgress);

  if (progressAnimationFrame === 0) {
    progressAnimationFrame = window.requestAnimationFrame(tickProgressAnimation);
  }
}

function applyProgressWidth(pct) {
  const width = `${pct.toFixed(2)}%`;
  if (ui.progressBar) ui.progressBar.style.width = width;
  if (ui.topProgressBar) ui.topProgressBar.style.width = width;
}

function tickProgressAnimation() {
  progressAnimationFrame = 0;
  const delta = progressTargetPct - progressRenderedPct;
  if (Math.abs(delta) <= 0.05) {
    progressRenderedPct = progressTargetPct;
    applyProgressWidth(progressRenderedPct);
    return;
  }

  // Ease toward the target so loading appears continuous even when updates are coarse.
  const step = Math.sign(delta) * Math.max(0.28, Math.abs(delta) * 0.14);
  progressRenderedPct += step;
  if (step > 0 && progressRenderedPct > progressTargetPct) progressRenderedPct = progressTargetPct;
  if (step < 0 && progressRenderedPct < progressTargetPct) progressRenderedPct = progressTargetPct;
  applyProgressWidth(progressRenderedPct);
  progressAnimationFrame = window.requestAnimationFrame(tickProgressAnimation);
}

function niceInt(x) {
  try { return new Intl.NumberFormat().format(x); } catch { return String(x); }
}

function safeParseFloat(x) {
  const v = Number.parseFloat(x);
  return Number.isFinite(v) ? v : null;
}

function waitMs(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function exportRetryDelayMs(attemptNumber) {
  const attempt = Math.max(1, Number(attemptNumber) || 1);
  const idx = Math.min(EXPORT_RETRY_DELAYS_MS.length - 1, attempt - 1);
  return EXPORT_RETRY_DELAYS_MS[idx];
}

function createCanceledError(message = "Canceled.") {
  const err = new Error(String(message || "Canceled."));
  err.name = "AbortError";
  err.isCanceled = true;
  return err;
}

function isCanceledError(err) {
  if (!err) return false;
  return err.name === "AbortError" || err.isCanceled === true;
}

function throwIfCanceled(cancelToken, fallbackMessage = "Canceled.") {
  if (!cancelToken?.canceled) return;
  if (!cancelToken.cancelError) {
    cancelToken.cancelError = createCanceledError(cancelToken.reason || fallbackMessage);
  }
  throw cancelToken.cancelError;
}

async function waitMsCancellable(ms, cancelToken, fallbackMessage = "Canceled.") {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay <= 0) {
    throwIfCanceled(cancelToken, fallbackMessage);
    return;
  }
  const stepMs = 120;
  let remaining = delay;
  while (remaining > 0) {
    throwIfCanceled(cancelToken, fallbackMessage);
    const step = Math.min(stepMs, remaining);
    await waitMs(step);
    remaining -= step;
  }
  throwIfCanceled(cancelToken, fallbackMessage);
}

function sanitizeFilenamePart(raw, maxLen = 80) {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/[^\w\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "stop";
  return cleaned.slice(0, maxLen);
}

function stopCodeOrId(stop) {
  const code = String(stop?.stop_code || "").trim();
  if (code) return code;
  const stopId = String(stop?.stop_id || "").trim();
  return stopId || "stop";
}

function buildStopExportBaseName(stop) {
  return `#${sanitizeFilenamePart(stopCodeOrId(stop), 40)}`;
}

function buildStopExportFilename(stop, format) {
  const ext = format === "svg" ? "svg" : "png";
  return `${buildStopExportBaseName(stop)}.${ext}`;
}

function buildMassZipFilename(format, stopCount) {
  const date = new Date().toISOString().slice(0, 10);
  const ext = format === "svg" ? "svg" : "png";
  const count = Math.max(0, Number(stopCount) || 0);
  return `bus_stops_${date}_${ext}_${count}.zip`;
}

function stopDisplayLabel(stop) {
  const code = stopCodeOrId(stop);
  const name = String(stop?.stop_name || "").trim();
  return name ? `${code} (${name})` : code;
}

function uniqueFilename(baseName, usedNames) {
  if (!(usedNames instanceof Set)) return baseName;
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : "";
  let n = 2;
  while (true) {
    const candidate = `${stem}_${n}${ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    n += 1;
  }
}

function triggerBlobDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.download = filename;
    a.href = url;
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}

function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error(`Failed to render ${type} blob.`));
    }, type);
  });
}

function setMassDownloadStatus(text) {
  if (ui.massDownloadStatus) ui.massDownloadStatus.textContent = String(text || "");
}

function requestMassDownloadCancel() {
  if (!activeMassDownloadCancelToken || activeMassDownloadCancelToken.canceled) return;
  activeMassDownloadCancelToken.canceled = true;
  activeMassDownloadCancelToken.reason = "Mass download canceled by user.";
  signRenderToken += 1;
  setMassDownloadStatus("Cancel requested. Stopping after the current render step…");
  updateMassDownloadUi();
}

function updateMassSelectionCountText() {
  if (!ui.massSelectionCount) return;
  if (massSelectionMode) {
    ui.massSelectionCount.textContent = "Drag a region on the map.";
    return;
  }
  if (massSelectedStops.length > 0) {
    ui.massSelectionCount.textContent = `${niceInt(massSelectedStops.length)} stop${massSelectedStops.length === 1 ? "" : "s"} selected.`;
    return;
  }
  ui.massSelectionCount.textContent = "No region selected.";
}

function updateMassDownloadUi() {
  updateMassSelectionCountText();
  const canCancelMassDownload = !!activeMassDownloadCancelToken && exportJobInProgress;
  const cancelRequested = !!activeMassDownloadCancelToken?.canceled;
  if (ui.massSelectRegionBtn) {
    ui.massSelectRegionBtn.disabled = exportJobInProgress;
    ui.massSelectRegionBtn.textContent = massSelectionMode ? "Selecting…" : "Select Region";
  }
  if (ui.massDownloadFormat) ui.massDownloadFormat.disabled = exportJobInProgress;
  if (ui.massDownloadBtn) {
    ui.massDownloadBtn.disabled = exportJobInProgress || massSelectionMode || massSelectedStops.length === 0;
    ui.massDownloadBtn.hidden = canCancelMassDownload;
  }
  if (ui.massCancelBtn) {
    ui.massCancelBtn.hidden = !canCancelMassDownload;
    ui.massCancelBtn.disabled = !canCancelMassDownload || cancelRequested;
    ui.massCancelBtn.textContent = cancelRequested ? "Canceling…" : "Cancel ZIP";
  }
}

function setExportJobInProgress(next) {
  exportJobInProgress = !!next;
  if (ui.downloadBtn) ui.downloadBtn.disabled = exportJobInProgress;
  if (ui.downloadSvgBtn) ui.downloadSvgBtn.disabled = exportJobInProgress;
  if (ui.copyBtn) ui.copyBtn.disabled = exportJobInProgress;
  if (ui.showStopsToggle) ui.showStopsToggle.disabled = exportJobInProgress;
  updateMassDownloadUi();
}

function setMapInteractionLockedForMassSelection(locked) {
  if (!map) return;
  const handlers = [
    ["dragging", map.dragging],
    ["touchZoom", map.touchZoom],
    ["boxZoom", map.boxZoom],
    ["keyboard", map.keyboard],
  ];

  if (locked) {
    if (massSelectionMapHandlerState) return;
    const state = {};
    for (const [name, handler] of handlers) {
      const isEnabled = !!handler?.enabled?.();
      state[name] = isEnabled;
      if (isEnabled) handler.disable();
    }
    massSelectionMapHandlerState = state;
    return;
  }

  if (!massSelectionMapHandlerState) return;
  const state = massSelectionMapHandlerState;
  massSelectionMapHandlerState = null;
  for (const [name, handler] of handlers) {
    if (!state[name]) continue;
    handler?.enable?.();
  }
}

function buildGoogleMapsStopQueryName(stopNameRaw) {
  const stopName = String(stopNameRaw || "").trim();
  if (!stopName) return "";
  if (/^(EB|WB|NB|SB)\b/i.test(stopName)) return stopName;

  const m = stopName.match(/^(Eastbound|Westbound|Northbound|Southbound)\b/i);
  if (!m) return stopName;
  const abbr = DIRECTION_PREFIX_BY_WORD.get(m[1].toLowerCase());
  if (!abbr) return stopName;
  // Prefix directional abbreviation while keeping the full stop name to improve match quality.
  return `${abbr} ${stopName}`;
}

function buildGoogleMapsStopUrl(stop) {
  const stopCode = String(stop?.stop_code || "").trim();
  const stopId = String(stop?.stop_id || "").trim();
  const stopCodeOrId = stopCode || stopId;
  if (useTransLinkStopScheduleUrl && stopCodeOrId) {
    return `https://www.translink.ca/schedules-and-maps/stop/${encodeURIComponent(stopCodeOrId)}/schedule`;
  }
  const lat = safeParseFloat(stop?.stop_lat);
  const lon = safeParseFloat(stop?.stop_lon);
  const name = buildGoogleMapsStopQueryName(stop?.stop_name);
  const queryParts = [];
  if (name) queryParts.push(name);
  if (stopCode) queryParts.push(stopCode);
  else if (stopId) queryParts.push(stopId);
  const query = queryParts.join(" ").trim() || "Bus stop";

  if (useCenteredQrMapUrl && lat != null && lon != null) {
    // Bias search to this exact stop coordinate to reduce wrong-stop matches.
    return `https://www.google.com/maps/search/${encodeURIComponent(query)}/@${lat.toFixed(6)},${lon.toFixed(6)},20z`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function signCanvasFont(fontSpec) {
  return `${fontSpec.weight} ${fontSpec.size}px ${SIGN_TEMPLATE.typography.family}`;
}

function signSvgFontAttrs(fontSpec) {
  return `font-size="${fontSpec.size}" font-weight="${fontSpec.weight}" font-family="${SIGN_TEMPLATE.typography.family}"`;
}

function signLegendHeight(segments) {
  return Math.min(
    SIGN_TEMPLATE.legend.maxHeight,
    estimateLegendHeight(segments, SIGN_TEMPLATE.legend.maxItems),
  );
}

function getSignLayoutGeometry({
  width = SIGN_TEMPLATE.size.width,
  height = SIGN_TEMPLATE.size.height,
  legendHeight = 0,
} = {}) {
  const pad = SIGN_TEMPLATE.spacing.outerPad;
  const headerHeight = SIGN_TEMPLATE.header.height;
  const mapSectionTop = headerHeight + SIGN_TEMPLATE.map.sectionTopOffset;
  const mapOuterY = mapSectionTop + SIGN_TEMPLATE.map.outerTopOffset;
  const footerBaselineY = height - SIGN_TEMPLATE.footer.baselineInset;
  const mapOuterHeight = Math.max(
    SIGN_TEMPLATE.map.outerMinHeight,
    (footerBaselineY - mapOuterY) - SIGN_TEMPLATE.map.outerBottomGapFromFooter,
  );
  const mapOuterX = pad;
  const mapOuterWidth = width - (pad * 2);
  const mapInnerPad = SIGN_TEMPLATE.map.innerPad;
  return {
    width,
    height,
    pad,
    headerHeight,
    footerBaselineY,
    titleBaselineY: SIGN_TEMPLATE.header.titleBaselineY,
    codeBaselineY: SIGN_TEMPLATE.header.codeBaselineY,
    subtitleBaselineY: SIGN_TEMPLATE.header.subtitleBaselineY,
    mapTitleBaselineY: mapSectionTop + SIGN_TEMPLATE.map.titleBaselineOffset,
    mapOuterX,
    mapOuterY,
    mapOuterWidth,
    mapOuterHeight,
    mapInnerPad,
    mapInnerX: mapOuterX + mapInnerPad,
    mapInnerY: mapOuterY + mapInnerPad,
    mapInnerWidth: mapOuterWidth - (mapInnerPad * 2),
    mapInnerHeight: mapOuterHeight - (mapInnerPad * 2) - legendHeight,
    qrLayout: getSignHeaderQrLayout(width, pad),
  };
}

function getSignHeaderQrLayout(width, pad) {
  const { qrSize, qrY, qrFramePad, qrCaptionTopOffset } = SIGN_TEMPLATE.header;
  const size = qrSize;
  const x = width - pad - size;
  const y = qrY;
  const framePad = qrFramePad;
  return {
    x,
    y,
    size,
    frameX: x - framePad,
    frameY: y - framePad,
    frameSize: size + (framePad * 2),
    captionX: x + (size / 2),
    captionStartY: y + size + qrCaptionTopOffset,
  };
}

function drawHeaderQrFallbackOnCanvas(ctx, qrLayout) {
  ctx.fillStyle = SIGN_TEMPLATE.colors.qrFallbackBg;
  roundRect(
    ctx,
    qrLayout.x,
    qrLayout.y,
    qrLayout.size,
    qrLayout.size,
    SIGN_TEMPLATE.header.qrFallbackRadius,
    true,
    false,
  );
  ctx.fillStyle = SIGN_TEMPLATE.colors.qrFallbackText;
  ctx.font = signCanvasFont(SIGN_TEMPLATE.typography.qrFallback);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(
    SIGN_TEMPLATE.labels.qrFallback,
    qrLayout.x + (qrLayout.size / 2),
    qrLayout.y + (qrLayout.size / 2) + SIGN_TEMPLATE.header.qrFallbackLabelYOffset,
  );
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function loadImageFromSource(src) {
  const key = String(src || "");
  if (!key) return Promise.reject(new Error("Missing image source"));
  if (sourceImageCache.has(key)) return sourceImageCache.get(key);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    if (/^https?:\/\//i.test(key)) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = key;
  });
  sourceImageCache.set(key, p);
  p.catch(() => sourceImageCache.delete(key));
  return p;
}

function buildQrCodeDataUrl(text, size) {
  const qrGlobal = window.QRCode;
  if (!qrGlobal) {
    return Promise.reject(new Error("QRCode library not available"));
  }

  return new Promise((resolve, reject) => {
    const host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-99999px";
    host.style.top = "-99999px";
    host.style.width = "1px";
    host.style.height = "1px";
    host.style.overflow = "hidden";
    document.body.appendChild(host);

    const cleanup = () => {
      try { host.remove(); } catch {}
    };

    try {
      // eslint-disable-next-line no-new
      new qrGlobal(host, {
        text,
        width: size,
        height: size,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: qrGlobal.CorrectLevel?.M ?? 0,
      });
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error("QR code generation failed"));
      return;
    }

    const finish = () => {
      const canvas = host.querySelector("canvas");
      if (canvas) {
        const dataUrl = canvas.toDataURL("image/png");
        cleanup();
        resolve(dataUrl);
        return;
      }

      const img = host.querySelector("img");
      if (img?.src) {
        if (img.complete) {
          const src = img.src;
          cleanup();
          resolve(src);
          return;
        }
        img.onload = () => {
          const src = img.src;
          cleanup();
          resolve(src);
        };
        img.onerror = () => {
          cleanup();
          reject(new Error("QR code image failed to load"));
        };
        return;
      }

      cleanup();
      reject(new Error("QR code render did not return an image"));
    };

    requestAnimationFrame(finish);
  });
}

function getStopQrCodeDataUrl(stop, size = SIGN_TEMPLATE.qrExportSize) {
  const targetUrl = buildGoogleMapsStopUrl(stop);
  const cacheKey = `${size}::${targetUrl}`;
  if (headerQrCodeDataUrlCache.has(cacheKey)) return headerQrCodeDataUrlCache.get(cacheKey);
  const p = buildQrCodeDataUrl(targetUrl, size);
  headerQrCodeDataUrlCache.set(cacheKey, p);
  p.catch(() => headerQrCodeDataUrlCache.delete(cacheKey));
  return p;
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

function parseGtfsDateKey(v) {
  if (v == null) return null;
  const raw = String(v).trim();
  if (!/^\d{8}$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function dateKeyToIsoDate(dateKey) {
  if (!Number.isFinite(dateKey)) return "";
  const raw = String(Math.trunc(dateKey)).padStart(8, "0");
  const y = raw.slice(0, 4);
  const m = raw.slice(4, 6);
  const d = raw.slice(6, 8);
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return "";
  return `${y}-${m}-${d}`;
}

function parseDateKeyFromHistoryGtfsUrl(url) {
  const raw = String(url || "");
  const m = raw.match(/\/History\/(\d{4})-(\d{2})-(\d{2})\/google_transit\.zip(?:$|[?#])/i);
  if (!m) return null;
  return parseGtfsDateKey(`${m[1]}${m[2]}${m[3]}`);
}

function formatDateKeyForDisplay(dateKey) {
  if (!Number.isFinite(dateKey)) return "";
  const raw = String(Math.trunc(dateKey)).padStart(8, "0");
  const y = Number.parseInt(raw.slice(0, 4), 10);
  const m = Number.parseInt(raw.slice(4, 6), 10);
  const d = Number.parseInt(raw.slice(6, 8), 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return "";
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y
    || (dt.getUTCMonth() + 1) !== m
    || dt.getUTCDate() !== d
  ) return "";
  return dt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function extractDateKeysFromText(text) {
  const src = String(text || "");
  const matches = src.match(/\d{8}/g) || [];
  const out = [];
  for (const token of matches) {
    const key = parseGtfsDateKey(token);
    if (key != null) out.push(key);
  }
  return out;
}

function feedDateCandidatesFromInfoRow(row) {
  const candidates = [];
  const versionKeys = extractDateKeysFromText(row?.feed_version);
  for (const key of versionKeys) candidates.push(key);

  if (candidates.length === 0) {
    const start = parseGtfsDateKey(row?.feed_start_date);
    if (start != null) candidates.push(start);
  }
  if (candidates.length === 0) {
    const end = parseGtfsDateKey(row?.feed_end_date);
    if (end != null) candidates.push(end);
  }
  candidates.sort((a, b) => b - a);
  return candidates;
}

function deriveFeedUpdatedDateLabel(feedInfoRows) {
  if (!Array.isArray(feedInfoRows) || feedInfoRows.length === 0) return "";
  const row = feedInfoRows[0] || {};
  const candidates = feedDateCandidatesFromInfoRow(row);
  for (const key of candidates) {
    const label = formatDateKeyForDisplay(key);
    if (label) return label;
  }
  return "";
}

function deriveFeedUpdatedDateKey(feedInfoRows) {
  if (!Array.isArray(feedInfoRows) || feedInfoRows.length === 0) return null;
  const row = feedInfoRows[0] || {};
  const candidates = feedDateCandidatesFromInfoRow(row);
  return candidates.length ? candidates[0] : null;
}

function contributionUrlForFooter() {
  try {
    const href = String(window?.location?.href || "").trim();
    if (/^https?:\/\//i.test(href)) return href;
  } catch {
    // Ignore and fall back.
  }
  return CONTRIBUTION_URL_FALLBACK;
}

function signFooterText() {
  const contribution = `Contribute at ${contributionUrlForFooter()}`;
  const base = "Created by Jared Tweed";
  if (!feedUpdatedDateLabel) return `${base} • ${contribution}`;
  return `${base} • Updated ${feedUpdatedDateLabel} • ${contribution}`;
}

function isCurrentFeedUpToDateWithDownloadLink() {
  if (!Number.isFinite(feedUpdatedDateKey)) return false;
  const linkDateKey = parseDateKeyFromHistoryGtfsUrl(TRANSLINK_LATEST_GTFS_URL);
  if (!Number.isFinite(linkDateKey)) return false;
  return feedUpdatedDateKey === linkDateKey;
}

function setUpdatesUi({ showButton = false, showStatus = false, statusText = "GTFS Uploaded", buttonText = "Download Updated GTFS File", disableButton = false } = {}) {
  if (ui.reloadBtn) {
    ui.reloadBtn.style.display = showButton ? "" : "none";
    ui.reloadBtn.textContent = buttonText;
    ui.reloadBtn.disabled = !!disableButton;
  }
  if (ui.updatesStatus) {
    ui.updatesStatus.style.display = showStatus ? "" : "none";
    ui.updatesStatus.textContent = statusText;
  }
}

function dateKeyToUtcDate(dateKey) {
  const raw = String(Math.trunc(dateKey || 0)).padStart(8, "0");
  const y = Number.parseInt(raw.slice(0, 4), 10);
  const m = Number.parseInt(raw.slice(4, 6), 10);
  const d = Number.parseInt(raw.slice(6, 8), 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const out = new Date(Date.UTC(y, m - 1, d));
  if (
    out.getUTCFullYear() !== y
    || (out.getUTCMonth() + 1) !== m
    || out.getUTCDate() !== d
  ) return null;
  return out;
}

function utcDateToDateKey(d) {
  if (!(d instanceof Date)) return null;
  return Number.parseInt(
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
    10,
  );
}

function weekdayFromDateKey(dateKey) {
  const d = dateKeyToUtcDate(dateKey);
  return d ? d.getUTCDay() : null;
}

function forEachDateKeyInRange(startKey, endKey, cb) {
  const start = dateKeyToUtcDate(startKey);
  const end = dateKeyToUtcDate(endKey);
  if (!start || !end || start > end || typeof cb !== "function") return;

  const cur = new Date(start.getTime());
  while (cur <= end) {
    const key = utcDateToDateKey(cur);
    if (key != null && cb(key) === true) break;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}

function buildServiceActiveWeekdays(calendarRows, calendarDateRows) {
  const calendarByService = new Map();
  const exceptionsByService = new Map();
  const weekdayCols = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  for (const row of calendarRows || []) {
    const sid = String(row?.service_id || "").trim();
    if (!sid) continue;
    const start = parseGtfsDateKey(row?.start_date);
    const end = parseGtfsDateKey(row?.end_date);
    if (start == null || end == null || end < start) continue;
    const flags = weekdayCols.map((col) => String(row?.[col] || "0").trim() === "1");
    let arr = calendarByService.get(sid);
    if (!arr) {
      arr = [];
      calendarByService.set(sid, arr);
    }
    arr.push({ start, end, flags });
  }

  for (const row of calendarDateRows || []) {
    const sid = String(row?.service_id || "").trim();
    const key = parseGtfsDateKey(row?.date);
    const exType = String(row?.exception_type || "").trim();
    if (!sid || key == null || (exType !== "1" && exType !== "2")) continue;
    let byDate = exceptionsByService.get(sid);
    if (!byDate) {
      byDate = new Map();
      exceptionsByService.set(sid, byDate);
    }
    byDate.set(key, exType);
  }

  const serviceIds = new Set([...calendarByService.keys(), ...exceptionsByService.keys()]);
  const out = new Map();

  for (const sid of serviceIds) {
    const rows = calendarByService.get(sid) || [];
    const byDate = exceptionsByService.get(sid) || new Map();
    let minKey = Infinity;
    let maxKey = -Infinity;
    for (const row of rows) {
      if (row.start < minKey) minKey = row.start;
      if (row.end > maxKey) maxKey = row.end;
    }
    for (const key of byDate.keys()) {
      if (key < minKey) minKey = key;
      if (key > maxKey) maxKey = key;
    }
    if (!Number.isFinite(minKey) || !Number.isFinite(maxKey) || maxKey < minKey) continue;

    const activeWeekdays = new Set();
    forEachDateKeyInRange(minKey, maxKey, (dateKey) => {
      const weekday = weekdayFromDateKey(dateKey);
      if (weekday == null) return false;

      let isActive = false;
      for (const row of rows) {
        if (dateKey < row.start || dateKey > row.end) continue;
        if (row.flags[weekday]) {
          isActive = true;
          break;
        }
      }

      const exType = byDate.get(dateKey);
      if (exType === "1") isActive = true;
      else if (exType === "2") isActive = false;

      if (isActive) activeWeekdays.add(weekday);
      return activeWeekdays.size >= 7;
    });

    if (activeWeekdays.size > 0) out.set(sid, activeWeekdays);
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

function parseLegendClockTokenToSeconds(token) {
  const raw = String(token || "").trim().toLowerCase();
  const m = raw.match(/^(\d{1,2}):(\d{2})(am|pm)(?:\+(\d+))?$/);
  if (!m) return null;
  let h = Number.parseInt(m[1], 10);
  const mi = Number.parseInt(m[2], 10);
  const ampm = m[3];
  const dayOffset = Number.parseInt(m[4] || "0", 10);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || !Number.isFinite(dayOffset)) return null;
  if (h < 1 || h > 12 || mi < 0 || mi > 59 || dayOffset < 0) return null;
  h %= 12;
  if (ampm === "pm") h += 12;
  return (dayOffset * 86400) + (h * 3600) + (mi * 60);
}

function parseLegendRangeToBounds(rangeText) {
  const raw = String(rangeText || "").trim();
  if (!raw) return null;
  const parts = raw.split("-").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const start = parseLegendClockTokenToSeconds(parts[0]);
  if (!Number.isFinite(start)) return null;
  let end = start;
  if (parts.length >= 2) {
    const parsedEnd = parseLegendClockTokenToSeconds(parts[parts.length - 1]);
    if (!Number.isFinite(parsedEnd)) return null;
    end = parsedEnd;
  }
  if (end < start) end = start;
  return { start, end };
}

function mergeRangeBounds(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
  };
}

function parseActiveHoursTextByGroup(activeText) {
  const text = String(activeText || "").trim();
  if (!text) return null;

  const out = {
    monfri: null,
    sat: null,
    sun: null,
    parsed: false,
  };

  const apply = (groupKey, rawRange) => {
    const bounds = parseLegendRangeToBounds(rawRange);
    if (!bounds) return;
    out[groupKey] = mergeRangeBounds(out[groupKey], bounds);
    out.parsed = true;
  };

  const allDaysMatch = text.match(/\bAll days\s*\(([^)]+)\)/i);
  if (allDaysMatch) {
    apply("monfri", allDaysMatch[1]);
    apply("sat", allDaysMatch[1]);
    apply("sun", allDaysMatch[1]);
  }

  const monfriMatch = text.match(/\bMon-Fri\s*\(([^)]+)\)/i);
  const satMatch = text.match(/\bSat\s*\(([^)]+)\)/i);
  const sunMatch = text.match(/\bSun\s*\(([^)]+)\)/i);
  if (monfriMatch) apply("monfri", monfriMatch[1]);
  if (satMatch) apply("sat", satMatch[1]);
  if (sunMatch) apply("sun", sunMatch[1]);

  if (!out.parsed) {
    const fallback = parseLegendRangeToBounds(text);
    if (!fallback) return null;
    out.monfri = mergeRangeBounds(out.monfri, fallback);
    out.sat = mergeRangeBounds(out.sat, fallback);
    out.sun = mergeRangeBounds(out.sun, fallback);
    out.parsed = true;
  }

  return out.parsed ? out : null;
}

function mergedActiveHoursTextForLegend(activeTexts) {
  const merged = { monfri: null, sat: null, sun: null };
  let parsedAny = false;
  for (const text of activeTexts || []) {
    const parsed = parseActiveHoursTextByGroup(text);
    if (!parsed) continue;
    parsedAny = true;
    merged.monfri = mergeRangeBounds(merged.monfri, parsed.monfri);
    merged.sat = mergeRangeBounds(merged.sat, parsed.sat);
    merged.sun = mergeRangeBounds(merged.sun, parsed.sun);
  }
  if (!parsedAny) return "";

  const fmt = (b) => (!b ? "" : (b.start === b.end
    ? formatClockTimeFromSeconds(b.start)
    : `${formatClockTimeFromSeconds(b.start)}-${formatClockTimeFromSeconds(b.end)}`));
  const monfri = fmt(merged.monfri);
  const sat = fmt(merged.sat);
  const sun = fmt(merged.sun);
  if (monfri && sat && sun && monfri === sat && sat === sun) return `All days (${monfri})`;

  const parts = [];
  if (monfri) parts.push(`Mon-Fri (${monfri})`);
  if (sat) parts.push(`Sat (${sat})`);
  if (sun) parts.push(`Sun (${sun})`);
  return parts.join(", ");
}

function buildLegendLinesForSegment(seg, maxChars = 116) {
  const route = (seg?.display_name || seg?.route_short_name || "Route").toString().trim();
  const active = (seg?.active_hours_text || "").toString().trim();
  if (!active) return [route];
  const combined = `${route} ${active}`.trim();
  if (combined.length <= maxChars) return [combined];
  return [route, active];
}

function estimateLegendHeight(segments, maxSegments = 6) {
  const use = (segments || []).slice(0, maxSegments);
  let lineCount = 0;
  for (const seg of use) lineCount += Math.max(1, buildLegendLinesForSegment(seg).length);
  const perLine = 16;
  const itemGap = 2;
  return Math.max(56, 10 + (lineCount * perLine) + (Math.max(0, use.length - 1) * itemGap));
}

function routeSortMetaFromLegendEntry(seg) {
  const raw = String(seg?.route_short_name || seg?.display_name || "").trim();
  const firstPart = raw.split("+")[0]?.trim() || raw;
  const m = firstPart.match(/\d+/);
  const num = m ? Number.parseInt(m[0], 10) : Number.NaN;
  return {
    raw,
    num,
    isNum: Number.isFinite(num),
  };
}

function sortedLegendEntries(entries) {
  const items = Array.isArray(entries) ? entries.slice() : [];
  items.sort((a, b) => {
    const sa = routeSortMetaFromLegendEntry(a);
    const sb = routeSortMetaFromLegendEntry(b);
    if (sa.isNum && sb.isNum && sa.num !== sb.num) return sa.num - sb.num;
    if (sa.isNum !== sb.isNum) return sa.isNum ? -1 : 1;
    return sa.raw.localeCompare(sb.raw);
  });
  return items;
}

function routeSegmentKey(seg) {
  return seg?.overlap_route_id || `${seg?.route_id || ""}::${seg?.shape_id || ""}`;
}

function downstreamStopSignatureForSegment(seg, routeStopMarkersBySegment) {
  if (!(routeStopMarkersBySegment instanceof Map)) return "";
  const markers = routeStopMarkersBySegment.get(routeSegmentKey(seg));
  if (!Array.isArray(markers) || markers.length === 0) return "";
  const stopIds = new Set();
  for (const marker of markers) {
    const stopId = String(marker?.stop_id || "").trim();
    if (!stopId) return "";
    stopIds.add(stopId);
  }
  return Array.from(stopIds).sort().join("|");
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingRouteShortFromLabel(shortName, label) {
  const short = String(shortName || "").trim();
  const raw = String(label || "").trim();
  if (!short || !raw) return raw;
  const shortEscaped = escapeRegExp(short);
  let out = raw.replace(new RegExp(`^${shortEscaped}\\b\\s*`, "i"), "");
  out = out.replace(/^[-:/|,()]+/, "").trim();
  if (!out || out.toLowerCase() === short.toLowerCase()) return "";
  return out;
}

function legendLabelForSegment(seg, shortGroupCount) {
  const short = String(seg?.route_short_name || "").trim();
  const display = String(seg?.display_name || "").trim();
  if (!short) return display || "Route";

  const appearsInMultipleLegendGroups = (shortGroupCount?.get(short) || 0) > 1;
  if (!appearsInMultipleLegendGroups) return short;

  const qualifier = stripLeadingRouteShortFromLabel(short, display);
  if (!qualifier) return short;
  return `${short} ${qualifier}`;
}

function segmentIdentityKeyForForcedMerge(seg) {
  const short = String(seg?.route_short_name || "").trim().toLowerCase();
  const display = String(seg?.display_name || "").trim().toLowerCase();
  if (!short || !display) return "";
  return `${short}::${display}`;
}

function mergeStopMarkersOrJoin(segments, routeStopMarkersBySegment) {
  if (!(routeStopMarkersBySegment instanceof Map) || !Array.isArray(segments) || segments.length === 0) return [];
  const seenStopIds = new Set();
  const out = [];
  for (const seg of segments) {
    const markers = routeStopMarkersBySegment.get(routeSegmentKey(seg));
    if (!Array.isArray(markers)) continue;
    for (const marker of markers) {
      const stopId = String(marker?.stop_id || "").trim();
      if (!stopId || seenStopIds.has(stopId)) continue;
      seenStopIds.add(stopId);
      out.push(marker);
    }
  }
  return out;
}

function buildSharedStopPatternRenderPlan(segments, routeStopMarkersBySegment) {
  const safeSegments = Array.isArray(segments) ? segments : [];
  const segmentMeta = safeSegments.map((seg) => ({
    seg,
    segKey: routeSegmentKey(seg),
    stopSig: downstreamStopSignatureForSegment(seg, routeStopMarkersBySegment),
    identityKey: segmentIdentityKeyForForcedMerge(seg),
  }));

  const identityBuckets = new Map();
  const stopSigBuckets = new Map();
  for (const meta of segmentMeta) {
    if (meta.identityKey) {
      if (!identityBuckets.has(meta.identityKey)) identityBuckets.set(meta.identityKey, []);
      identityBuckets.get(meta.identityKey).push(meta);
    }
    if (meta.stopSig) {
      if (!stopSigBuckets.has(meta.stopSig)) stopSigBuckets.set(meta.stopSig, []);
      stopSigBuckets.get(meta.stopSig).push(meta);
    }
  }

  const groups = [];
  const visitedSegKeys = new Set();
  for (const startMeta of segmentMeta) {
    if (visitedSegKeys.has(startMeta.segKey)) continue;

    const queue = [startMeta];
    const componentMeta = [];
    const seenIdentityKeys = new Set();
    const seenStopSigs = new Set();

    while (queue.length > 0) {
      const cur = queue.pop();
      if (!cur || visitedSegKeys.has(cur.segKey)) continue;
      visitedSegKeys.add(cur.segKey);
      componentMeta.push(cur);

      if (cur.identityKey && !seenIdentityKeys.has(cur.identityKey)) {
        seenIdentityKeys.add(cur.identityKey);
        const identityPeers = identityBuckets.get(cur.identityKey) || [];
        for (const peer of identityPeers) {
          if (!visitedSegKeys.has(peer.segKey)) queue.push(peer);
        }
      }

      if (cur.stopSig && !seenStopSigs.has(cur.stopSig)) {
        seenStopSigs.add(cur.stopSig);
        const stopSigPeers = stopSigBuckets.get(cur.stopSig) || [];
        for (const peer of stopSigPeers) {
          if (!visitedSegKeys.has(peer.segKey)) queue.push(peer);
        }
      }
    }

    const members = [];
    const stopSigs = [];
    for (const meta of componentMeta) {
      members.push(meta.seg);
      if (meta.stopSig) stopSigs.push(meta.stopSig);
    }
    const uniqueStopSigs = Array.from(new Set(stopSigs));
    groups.push({
      members,
      stopSig: uniqueStopSigs.length === 1 ? uniqueStopSigs[0] : uniqueStopSigs.join(" OR "),
    });
  }

  const shortGroupCount = new Map();
  for (const group of groups) {
    const groupShorts = new Set();
    for (const seg of group.members) {
      const short = String(seg?.route_short_name || "").trim();
      if (short) groupShorts.add(short);
    }
    for (const short of groupShorts) {
      shortGroupCount.set(short, (shortGroupCount.get(short) || 0) + 1);
    }
  }

  const drawSegments = [];
  const legendEntries = [];
  const mergedRouteStopMarkersBySegment = new Map();
  for (const group of groups) {
    const members = group.members;
    if (members.length === 0) continue;

    const groupColor = String(members[0]?.lineColor || "#2b6dff");
    if (group.stopSig && members.length > 1) {
      for (const seg of members) seg.lineColor = groupColor;
    }

    const representative = members[0];
    const representativeKey = routeSegmentKey(representative);
    const mergedMarkers = mergeStopMarkersOrJoin(members, routeStopMarkersBySegment);
    if (mergedMarkers.length > 0) {
      mergedRouteStopMarkersBySegment.set(representativeKey, mergedMarkers);
    } else if (routeStopMarkersBySegment instanceof Map) {
      const fallbackMarkers = routeStopMarkersBySegment.get(representativeKey);
      if (Array.isArray(fallbackMarkers) && fallbackMarkers.length > 0) {
        mergedRouteStopMarkersBySegment.set(representativeKey, fallbackMarkers);
      }
    }

    if (!(group.stopSig && members.length > 1)) {
      const label = legendLabelForSegment(representative, shortGroupCount);
      drawSegments.push(representative);
      legendEntries.push({
        lineColor: representative.lineColor,
        display_name: label,
        route_short_name: label,
        active_hours_text: representative.active_hours_text || "",
      });
      continue;
    }

    const labels = [];
    const labelSeen = new Set();
    const activeValues = [];
    const activeSeen = new Set();
    for (const seg of members) {
      const label = legendLabelForSegment(seg, shortGroupCount);
      if (!labelSeen.has(label)) {
        labelSeen.add(label);
        labels.push(label);
      }
      const active = String(seg?.active_hours_text || "").trim();
      if (active && !activeSeen.has(active)) {
        activeSeen.add(active);
        activeValues.push(active);
      }
    }

    drawSegments.push(representative);
    legendEntries.push({
      lineColor: groupColor,
      display_name: labels.join(" + "),
      route_short_name: labels.join(" + "),
      active_hours_text: mergedActiveHoursTextForLegend(activeValues),
    });
  }

  return {
    drawSegments,
    legendEntries,
    mergedRouteStopMarkersBySegment,
  };
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

function resetTripStopOverlayCaches() {
  tripIndexReady = false;
  candidateTripsByRouteShapeDirectionHeadsign = new Map();
  candidateTripsByRouteShapeDirection = new Map();
  candidateTripsByRouteShape = new Map();
  tripStopsByTripId = new Map();
  routeStopsOverlayCache = new Map();
  if (stopOverlayWorker) {
    try { stopOverlayWorker.terminate(); } catch {}
  }
  stopOverlayWorker = null;
  stopOverlayWorkerReady = false;
  stopOverlayWorkerInitPromise = null;
  stopOverlayWorkerRequestSeq = 0;
  for (const pending of stopOverlayWorkerPending.values()) {
    try { pending.reject(new Error("Stop overlay worker reset")); } catch {}
  }
  stopOverlayWorkerPending = new Map();
}

function ensureStopOverlayWorker() {
  if (stopOverlayWorker) return stopOverlayWorker;
  if (typeof Worker === "undefined") return null;

  stopOverlayWorker = new Worker(STOP_OVERLAY_WORKER_URL);
  stopOverlayWorker.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === "progress") return;

    const reqId = Number(msg.requestId);
    if (!Number.isFinite(reqId)) return;
    const pending = stopOverlayWorkerPending.get(reqId);
    if (!pending) return;
    stopOverlayWorkerPending.delete(reqId);

    if (msg.type === "error") {
      pending.reject(new Error(msg.error || "Stop overlay worker error"));
      return;
    }
    pending.resolve(msg);
  };

  stopOverlayWorker.onerror = (err) => {
    console.warn("Stop overlay worker failed.", err);
    const failErr = new Error(err?.message || "Stop overlay worker runtime error");
    for (const pending of stopOverlayWorkerPending.values()) {
      try { pending.reject(failErr); } catch {}
    }
    stopOverlayWorkerPending = new Map();
    try { stopOverlayWorker?.terminate(); } catch {}
    stopOverlayWorker = null;
    stopOverlayWorkerReady = false;
    stopOverlayWorkerInitPromise = null;
    stopOverlayWorkerRequestSeq = 0;
  };

  return stopOverlayWorker;
}

function requestStopOverlayWorker(type, payload = {}, transfer = []) {
  const worker = ensureStopOverlayWorker();
  if (!worker) return Promise.reject(new Error("Worker API unavailable"));

  const requestId = ++stopOverlayWorkerRequestSeq;
  return new Promise((resolve, reject) => {
    stopOverlayWorkerPending.set(requestId, { resolve, reject });
    worker.postMessage({ type, requestId, ...payload }, transfer);
  });
}

async function ensureStopOverlayWorkerIndex() {
  if (stopOverlayWorkerReady) return true;
  if (stopOverlayWorkerInitPromise) return stopOverlayWorkerInitPromise;
  if (!activeZip) return false;
  const stopTimesFile = activeZip.file("stop_times.txt");
  if (!stopTimesFile) return false;
  if (!ensureStopOverlayWorker()) return false;

  stopOverlayWorkerInitPromise = (async () => {
    try {
      const stopTimesBuffer = await stopTimesFile.async("arraybuffer");
      await requestStopOverlayWorker("build_index", { stopTimesBuffer }, [stopTimesBuffer]);
      stopOverlayWorkerReady = true;
      return true;
    } catch (err) {
      console.warn("Stop overlay worker index build failed.", err);
      stopOverlayWorkerReady = false;
      return false;
    } finally {
      stopOverlayWorkerInitPromise = null;
    }
  })();

  return stopOverlayWorkerInitPromise;
}

async function prewarmStopOverlayData(generationAtStart) {
  if (generationAtStart !== bootGeneration) return;
  try {
    await ensureTripsLoadedForStopOverlay();
    if (generationAtStart !== bootGeneration) return;
    await ensureStopOverlayWorkerIndex();
  } catch (err) {
    console.warn("Stop overlay prewarm failed.", err);
  }
}

function normalizeHeadsignKey(v) {
  return String(v ?? "").trim().toLowerCase();
}

function routeShapeDirectionKey(routeId, shapeId, directionId) {
  return `${routeId || ""}::${shapeId || ""}::${directionId || ""}`;
}

function routeShapeKeyOnly(routeId, shapeId) {
  return `${routeId || ""}::${shapeId || ""}`;
}

function routeShapeDirectionHeadsignKey(routeId, shapeId, directionId, headsign) {
  return `${routeShapeDirectionKey(routeId, shapeId, directionId)}::${normalizeHeadsignKey(headsign)}`;
}

function addTripCandidate(mapObj, key, tripId) {
  if (!key || !tripId) return;
  let arr = mapObj.get(key);
  if (!arr) {
    arr = [];
    mapObj.set(key, arr);
  }
  if (arr.includes(tripId)) return;
  arr.push(tripId);
}

function ensureTripIndex() {
  if (tripIndexReady) return;

  candidateTripsByRouteShapeDirectionHeadsign = new Map();
  candidateTripsByRouteShapeDirection = new Map();
  candidateTripsByRouteShape = new Map();

  for (const [tripId, trip] of tripsById.entries()) {
    const routeId = String(trip?.route_id || "").trim();
    const shapeId = String(trip?.shape_id || "").trim();
    if (!routeId || !shapeId) continue;
    const directionId = String(trip?.direction_id ?? "").trim();
    const headsign = String(trip?.trip_headsign ?? "").trim();

    addTripCandidate(
      candidateTripsByRouteShapeDirectionHeadsign,
      routeShapeDirectionHeadsignKey(routeId, shapeId, directionId, headsign),
      tripId,
    );
    addTripCandidate(
      candidateTripsByRouteShapeDirection,
      routeShapeDirectionKey(routeId, shapeId, directionId),
      tripId,
    );
    addTripCandidate(
      candidateTripsByRouteShape,
      routeShapeKeyOnly(routeId, shapeId),
      tripId,
    );
  }

  tripIndexReady = true;
}

async function ensureTripsLoadedForStopOverlay() {
  if (tripsById.size > 0) return;
  if (!activeZip) return;
  const trips = await parseCSVFromZip(activeZip, "trips.txt");
  for (const t of trips) {
    if (!t?.trip_id) continue;
    tripsById.set(t.trip_id, {
      route_id: t.route_id,
      direction_id: (t.direction_id ?? "").toString(),
      trip_headsign: t.trip_headsign ?? "",
      shape_id: (t.shape_id ?? "").toString(),
      service_id: (t.service_id ?? "").toString(),
    });
  }
  tripIndexReady = false;
}

function tripCandidateIdsForSegment(seg) {
  ensureTripIndex();
  const routeId = String(seg?.route_id || "").trim();
  const shapeId = String(seg?.shape_id || "").trim();
  if (!routeId || !shapeId) return [];
  const directionId = String(seg?.direction_id ?? "").trim();
  const headsign = String(seg?.headsign ?? "").trim();

  const keys = [
    routeShapeDirectionHeadsignKey(routeId, shapeId, directionId, headsign),
    routeShapeDirectionKey(routeId, shapeId, directionId),
    routeShapeKeyOnly(routeId, shapeId),
  ];
  const pools = [
    candidateTripsByRouteShapeDirectionHeadsign,
    candidateTripsByRouteShapeDirection,
    candidateTripsByRouteShape,
  ];

  const seen = new Set();
  const out = [];
  for (let i = 0; i < keys.length; i += 1) {
    const arr = pools[i].get(keys[i]) || [];
    for (const tripId of arr) {
      if (seen.has(tripId)) continue;
      seen.add(tripId);
      out.push(tripId);
      if (out.length >= STOP_OVERLAY_TRIP_CANDIDATE_LIMIT) return out;
    }
  }
  return out;
}

async function ensureTripStopSequencesFromZipScan(needTripIds) {
  if (!Array.isArray(needTripIds) || needTripIds.length === 0) return;
  if (!activeZip) return;

  const needSet = new Set(needTripIds);
  const rowsByTrip = new Map();
  for (const tripId of needTripIds) rowsByTrip.set(tripId, []);

  await parseCSVFromZip(activeZip, "stop_times.txt", {
    stepRow: (row) => {
      const tripId = row?.trip_id;
      if (!tripId || !needSet.has(tripId)) return;
      const stopId = row?.stop_id;
      if (!stopId) return;
      const seq = Number.parseInt(row?.stop_sequence, 10);
      const arr = rowsByTrip.get(tripId);
      arr.push({
        stop_id: String(stopId),
        seq: Number.isFinite(seq) ? seq : arr.length,
      });
    },
  });

  for (const tripId of needTripIds) {
    const rows = rowsByTrip.get(tripId) || [];
    rows.sort((a, b) => a.seq - b.seq);
    const out = [];
    let lastKey = "";
    for (const row of rows) {
      const key = `${row.seq}::${row.stop_id}`;
      if (key === lastKey) continue;
      lastKey = key;
      out.push(row.stop_id);
    }
    tripStopsByTripId.set(tripId, out);
  }
}

async function ensureTripStopSequencesForTripIds(tripIds) {
  const need = [];
  for (const tripId of tripIds) {
    if (!tripId || tripStopsByTripId.has(tripId)) continue;
    need.push(tripId);
  }
  if (need.length === 0) return;
  if (!activeZip) return;

  const workerReady = await ensureStopOverlayWorkerIndex();
  if (workerReady) {
    try {
      const msg = await requestStopOverlayWorker("get_trip_stops", { tripIds: need });
      const byTrip = msg?.tripStopsByTripId || {};
      for (const tripId of need) {
        const seq = byTrip[tripId];
        if (Array.isArray(seq)) {
          tripStopsByTripId.set(tripId, seq.map((x) => String(x)));
        } else {
          tripStopsByTripId.set(tripId, []);
        }
      }
      return;
    } catch (err) {
      console.warn("Stop overlay worker query failed; falling back to zip scan.", err);
    }
  }

  const stillNeed = need.filter((tripId) => !tripStopsByTripId.has(tripId));
  if (stillNeed.length === 0) return;

  // Fallback for first click before worker index is ready.
  await ensureTripStopSequencesFromZipScan(stillNeed);
}

function buildDownstreamStopMarkers(stopId, tripStopIds) {
  if (!stopId || !Array.isArray(tripStopIds) || tripStopIds.length === 0) return [];
  const idx = tripStopIds.indexOf(String(stopId));
  if (idx < 0) return [];

  const out = [];
  const seen = new Set();
  for (let i = idx + 1; i < tripStopIds.length; i += 1) {
    const sid = tripStopIds[i];
    if (!sid || sid === stopId || seen.has(sid)) continue;
    seen.add(sid);
    const stop = stopsById.get(sid);
    if (!stop) continue;
    const lat = safeParseFloat(stop.stop_lat);
    const lon = safeParseFloat(stop.stop_lon);
    if (lat == null || lon == null) continue;
    out.push({
      stop_id: sid,
      lat,
      lon,
    });
  }
  return out;
}

function routeStopOverlayCacheKey(stop, segments) {
  const stopId = String(stop?.stop_id || "");
  const sig = (segments || [])
    .map((seg) => `${seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`}::${seg.direction_id ?? ""}`)
    .join("|");
  return `${stopId}::${sig}`;
}

async function getRouteStopMarkersBySegment(stop, segments) {
  if (!stop || !Array.isArray(segments) || segments.length === 0) return new Map();

  const cacheKey = routeStopOverlayCacheKey(stop, segments);
  const cached = routeStopsOverlayCache.get(cacheKey);
  if (cached) return cached;

  const preloadedByShape = preloadedStopOverlayByStop.get(String(stop.stop_id || ""));
  if (preloadedByShape instanceof Map) {
    const bySegmentKey = new Map();
    for (const seg of segments) {
      const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
      const stopIds = preloadedByShape.get(segKey) || [];
      const markers = [];
      for (const sid of stopIds) {
        const stopRow = stopsById.get(String(sid));
        if (!stopRow) continue;
        const lat = safeParseFloat(stopRow.stop_lat);
        const lon = safeParseFloat(stopRow.stop_lon);
        if (lat == null || lon == null) continue;
        markers.push({ stop_id: String(sid), lat, lon });
      }
      bySegmentKey.set(segKey, markers);
    }
    routeStopsOverlayCache.set(cacheKey, bySegmentKey);
    return bySegmentKey;
  }

  await ensureTripsLoadedForStopOverlay();

  const candidateTripIdsBySegmentKey = new Map();
  const allTripIds = [];
  for (const seg of segments) {
    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    const tripIds = tripCandidateIdsForSegment(seg);
    candidateTripIdsBySegmentKey.set(segKey, tripIds);
    for (const tripId of tripIds) allTripIds.push(tripId);
  }

  await ensureTripStopSequencesForTripIds(allTripIds);

  const bySegmentKey = new Map();
  const stopId = String(stop.stop_id || "");
  for (const seg of segments) {
    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    const candidates = candidateTripIdsBySegmentKey.get(segKey) || [];
    let bestStops = [];
    let bestDownstreamCount = -1;

    for (const tripId of candidates) {
      const tripStops = tripStopsByTripId.get(tripId) || [];
      const idx = tripStops.indexOf(stopId);
      if (idx < 0) continue;
      const downstreamCount = tripStops.length - idx - 1;
      if (downstreamCount > bestDownstreamCount) {
        bestStops = tripStops;
        bestDownstreamCount = downstreamCount;
      }
    }

    const markers = buildDownstreamStopMarkers(stopId, bestStops);
    bySegmentKey.set(segKey, markers);
  }

  routeStopsOverlayCache.set(cacheKey, bySegmentKey);
  return bySegmentKey;
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
  const touchDevice = isCoarsePointerDevice();
  map = L.map("map", {
    preferCanvas: true,
    tapTolerance: touchDevice ? TOUCH_MAP_TAP_TOLERANCE : DEFAULT_MAP_TAP_TOLERANCE,
    renderer: L.canvas({ tolerance: touchDevice ? TOUCH_CANVAS_TOLERANCE : DEFAULT_CANVAS_TOLERANCE }),
  }).setView([49.25, -123.12], 11);

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
  ensureMassSelectionOverlay();
  updateMassDownloadUi();
}

function addStopsToMap() {
  markerCluster.clearLayers();
  const markerStyle = stopMarkerStyle();

  for (const s of stops) {
    const lat = safeParseFloat(s.stop_lat);
    const lon = safeParseFloat(s.stop_lon);
    if (lat == null || lon == null) continue;

    const m = L.circleMarker([lat, lon], {
      ...markerStyle,
    });

    const title = s.stop_name || "Stop";
    const code = s.stop_code ? ` (${s.stop_code})` : "";
    m.bindTooltip(`${title}${code}`, { direction: "top" });

    m.on("click", () => openStop(s));
    markerCluster.addLayer(m);
  }

  if (massSelectionBounds) {
    massSelectedStops = collectStopsInBounds(massSelectionBounds);
    updateMassDownloadUi();
  }
}

function ensureMassSelectionOverlay() {
  if (!map) return;
  if (massSelectionOverlay && massSelectionOverlay.isConnected) return;
  const container = map.getContainer();
  if (!container) return;

  const overlay = document.createElement("div");
  overlay.id = "massSelectionOverlay";
  overlay.innerHTML = `
    <div class="massSelectionOverlay__hint">Drag to select bus stops</div>
    <div class="massSelectionOverlay__rect"></div>
  `;
  container.appendChild(overlay);
  massSelectionOverlay = overlay;
  massSelectionRectEl = overlay.querySelector(".massSelectionOverlay__rect");

  overlay.addEventListener("pointerdown", onMassSelectionPointerDown);
  overlay.addEventListener("pointermove", onMassSelectionPointerMove);
  overlay.addEventListener("pointerup", onMassSelectionPointerUp);
  overlay.addEventListener("pointercancel", onMassSelectionPointerCancel);
  overlay.addEventListener("touchstart", onMassSelectionOverlayTouchEvent, { passive: false });
  overlay.addEventListener("touchmove", onMassSelectionOverlayTouchEvent, { passive: false });
  overlay.addEventListener("touchend", onMassSelectionOverlayTouchEvent, { passive: false });
  overlay.addEventListener("touchcancel", onMassSelectionOverlayTouchEvent, { passive: false });
}

function overlayPointFromPointerEvent(ev) {
  if (!massSelectionOverlay) return null;
  const rect = massSelectionOverlay.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.max(0, Math.min(rect.width, ev.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, ev.clientY - rect.top)),
  };
}

function selectionRectFromState(state) {
  const left = Math.min(state.startX, state.currentX);
  const top = Math.min(state.startY, state.currentY);
  const width = Math.abs(state.currentX - state.startX);
  const height = Math.abs(state.currentY - state.startY);
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function renderMassSelectionRect() {
  if (!massSelectionRectEl) return;
  if (!massSelectionDragState) {
    massSelectionRectEl.style.display = "none";
    return;
  }
  const rect = selectionRectFromState(massSelectionDragState);
  massSelectionRectEl.style.display = "block";
  massSelectionRectEl.style.left = `${rect.left}px`;
  massSelectionRectEl.style.top = `${rect.top}px`;
  massSelectionRectEl.style.width = `${rect.width}px`;
  massSelectionRectEl.style.height = `${rect.height}px`;
}

function endMassSelectionDragVisual() {
  massSelectionDragState = null;
  renderMassSelectionRect();
}

function setMassSelectionMode(next) {
  const enabled = !!next;
  massSelectionMode = enabled;
  setMapInteractionLockedForMassSelection(enabled);
  ensureMassSelectionOverlay();
  if (massSelectionOverlay) {
    massSelectionOverlay.classList.toggle("active", enabled);
  }
  if (!enabled) {
    endMassSelectionDragVisual();
  } else {
    setMassDownloadStatus("Drag a rectangle on the map to choose stops.");
  }
  updateMassDownloadUi();
}

function onMassSelectionOverlayTouchEvent(ev) {
  if (!massSelectionMode) return;
  ev.preventDefault();
  ev.stopPropagation();
}

function clearMassSelection() {
  massSelectionBounds = null;
  massSelectedStops = [];
  if (massSelectionLayer && map) {
    map.removeLayer(massSelectionLayer);
    massSelectionLayer = null;
  }
  updateMassDownloadUi();
}

function stopSortKey(stop) {
  return stopCodeOrId(stop);
}

function compareStopsForExport(a, b) {
  const ak = stopSortKey(a);
  const bk = stopSortKey(b);
  const an = Number.parseInt(ak, 10);
  const bn = Number.parseInt(bk, 10);
  const aNum = Number.isFinite(an);
  const bNum = Number.isFinite(bn);
  if (aNum && bNum && an !== bn) return an - bn;
  if (aNum !== bNum) return aNum ? -1 : 1;
  if (ak !== bk) return ak.localeCompare(bk);
  const aname = String(a?.stop_name || "");
  const bname = String(b?.stop_name || "");
  return aname.localeCompare(bname);
}

function collectStopsInBounds(bounds) {
  if (!bounds) return [];
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const crossesDateLine = west > east;

  const inLonRange = (lon) => {
    if (crossesDateLine) return lon >= west || lon <= east;
    return lon >= west && lon <= east;
  };

  return stops
    .filter((s) => {
      const lat = safeParseFloat(s?.stop_lat);
      const lon = safeParseFloat(s?.stop_lon);
      if (lat == null || lon == null) return false;
      return lat >= south && lat <= north && inLonRange(lon);
    })
    .sort(compareStopsForExport);
}

function applyMassSelectionBounds(bounds) {
  massSelectionBounds = bounds || null;
  if (!map) return;

  if (!massSelectionBounds) {
    clearMassSelection();
    return;
  }

  if (!massSelectionLayer) {
    massSelectionLayer = L.rectangle(massSelectionBounds, {
      color: "#2b6dff",
      weight: 2,
      fillOpacity: 0.06,
      interactive: false,
    }).addTo(map);
  } else {
    massSelectionLayer.setBounds(massSelectionBounds);
  }

  massSelectedStops = collectStopsInBounds(massSelectionBounds);
  updateMassDownloadUi();
}

function finalizeMassSelectionFromDragState() {
  if (!map || !massSelectionDragState) return;
  const rect = selectionRectFromState(massSelectionDragState);
  const dragDistance = Math.max(rect.width, rect.height);
  if (dragDistance < MASS_SELECT_DRAG_MIN_PX) {
    setMassDownloadStatus("Selection was too small. Drag a larger region.");
    return;
  }

  const nw = map.containerPointToLatLng([rect.left, rect.top]);
  const se = map.containerPointToLatLng([rect.right, rect.bottom]);
  const bounds = L.latLngBounds(nw, se);
  applyMassSelectionBounds(bounds);

  if (massSelectedStops.length === 0) {
    setMassDownloadStatus("No stops found in that region. Try a larger selection.");
  } else {
    setMassDownloadStatus(`${niceInt(massSelectedStops.length)} stop${massSelectedStops.length === 1 ? "" : "s"} selected. Choose PNG or SVG, then download.`);
  }
  setMassSelectionMode(false);
}

function onMassSelectionPointerDown(ev) {
  if (!massSelectionMode || exportJobInProgress || !massSelectionOverlay) return;
  const pt = overlayPointFromPointerEvent(ev);
  if (!pt) return;
  ev.preventDefault();
  ev.stopPropagation();
  massSelectionDragState = {
    pointerId: ev.pointerId,
    startX: pt.x,
    startY: pt.y,
    currentX: pt.x,
    currentY: pt.y,
  };
  massSelectionOverlay.setPointerCapture(ev.pointerId);
  renderMassSelectionRect();
}

function onMassSelectionPointerMove(ev) {
  if (!massSelectionMode || !massSelectionDragState) return;
  if (ev.pointerId !== massSelectionDragState.pointerId) return;
  const pt = overlayPointFromPointerEvent(ev);
  if (!pt) return;
  ev.preventDefault();
  ev.stopPropagation();
  massSelectionDragState.currentX = pt.x;
  massSelectionDragState.currentY = pt.y;
  renderMassSelectionRect();
}

function onMassSelectionPointerUp(ev) {
  if (!massSelectionMode || !massSelectionDragState) return;
  if (ev.pointerId !== massSelectionDragState.pointerId) return;
  const pt = overlayPointFromPointerEvent(ev);
  if (pt) {
    massSelectionDragState.currentX = pt.x;
    massSelectionDragState.currentY = pt.y;
  }
  ev.preventDefault();
  ev.stopPropagation();
  if (massSelectionOverlay?.hasPointerCapture(ev.pointerId)) {
    massSelectionOverlay.releasePointerCapture(ev.pointerId);
  }
  finalizeMassSelectionFromDragState();
  endMassSelectionDragVisual();
}

function onMassSelectionPointerCancel(ev) {
  if (!massSelectionMode || !massSelectionDragState) return;
  if (ev.pointerId !== massSelectionDragState.pointerId) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (massSelectionOverlay?.hasPointerCapture(ev.pointerId)) {
    massSelectionOverlay.releasePointerCapture(ev.pointerId);
  }
  endMassSelectionDragVisual();
  setMassDownloadStatus("Selection canceled.");
}

function openModal() {
  ui.modal.classList.remove("hidden");
  if (ui.modalBody) {
    ui.modalBody.scrollTop = 0;
    ui.modalBody.scrollLeft = 0;
  }
}
function closeModal() {
  ui.modal.classList.add("hidden");
  if (ui.modalBody) {
    ui.modalBody.scrollTop = 0;
    ui.modalBody.scrollLeft = 0;
  }
  if (ui.signCanvas) ui.signCanvas.style.cursor = "";
  resetPreviewZoom();
}

ui.modalBackdrop.addEventListener("click", closeModal);
ui.closeModal.addEventListener("click", closeModal);
ui.signWrap?.addEventListener("wheel", onSignPreviewWheel, { passive: false });
ui.signCanvas?.addEventListener("mousemove", updateSignCanvasCursor);
ui.signCanvas?.addEventListener("mouseleave", () => {
  if (ui.signCanvas) ui.signCanvas.style.cursor = "";
});
ui.signCanvas?.addEventListener("click", onSignCanvasClick);
window.addEventListener("keydown", onGlobalKeyDown);

function normalizeColor(hex, fallback="#333333") {
  if (!hex) return fallback;
  const v = String(hex).trim().replace("#", "");
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v}`;
  if (/^[0-9a-fA-F]{3}$/.test(v)) return `#${v}`;
  return fallback;
}

function distance2(latA, lonA, latB, lonB) {
  const dLat = latA - latB;
  const dLon = lonA - lonB;
  return dLat * dLat + dLon * dLon;
}

function projectPointToSegment(lat, lon, aLat, aLon, bLat, bLon) {
  const abLat = bLat - aLat;
  const abLon = bLon - aLon;
  const denom = (abLat * abLat) + (abLon * abLon);
  if (denom <= 1e-12) {
    return { t: 0, lat: aLat, lon: aLon, d2: distance2(lat, lon, aLat, aLon) };
  }
  const apLat = lat - aLat;
  const apLon = lon - aLon;
  let t = ((apLat * abLat) + (apLon * abLon)) / denom;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const pLat = aLat + (abLat * t);
  const pLon = aLon + (abLon * t);
  return { t, lat: pLat, lon: pLon, d2: distance2(lat, lon, pLat, pLon) };
}

function findClosestProjectionOnShape(shape, stopLat, stopLon) {
  if (!Array.isArray(shape) || shape.length < 2) return null;
  if (!Number.isFinite(stopLat) || !Number.isFinite(stopLon)) return null;

  let best = null;
  for (let i = 0; i < shape.length - 1; i += 1) {
    const [aLat, aLon] = shape[i];
    const [bLat, bLon] = shape[i + 1];
    const proj = projectPointToSegment(stopLat, stopLon, aLat, aLon, bLat, bLon);
    if (!best || proj.d2 < best.d2) {
      best = { ...proj, segIdx: i };
    }
  }
  return best;
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

    let clipped = shape.slice();
    if (stopLat != null && stopLon != null) {
      const proj = findClosestProjectionOnShape(shape, stopLat, stopLon);
      if (proj) {
        const eps = 1e-6;
        const segIdx = Math.max(0, Math.min(shape.length - 2, proj.segIdx));
        if (proj.t <= eps) {
          clipped = shape.slice(segIdx);
        } else if (proj.t >= (1 - eps)) {
          clipped = shape.slice(segIdx + 1);
        } else {
          clipped = [[proj.lat, proj.lon], ...shape.slice(segIdx + 1)];
        }
      }
    }
    if (clipped.length < 2) clipped = shape.slice(Math.max(0, shape.length - 2));
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
      direction_id: (it.direction_id ?? "").toString(),
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

  const maxMiter = Math.max(4, Math.abs(offsetPx) * 5);
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p = pts[i];
    const a = segs[i - 1];
    const b = segs[i];

    let bnx = a.nx + b.nx;
    let bny = a.ny + b.ny;
    let blen = Math.hypot(bnx, bny);
    if (blen <= 1e-6) {
      shifted[i] = {
        x: p.x + (a.nx * offsetPx),
        y: p.y + (a.ny * offsetPx),
      };
      continue;
    }
    const jnx = bnx / blen;
    const jny = bny / blen;

    const proj = (jnx * b.nx) + (jny * b.ny);
    const fallback = () => ({
      x: p.x + (((a.nx + b.nx) * 0.5) * offsetPx),
      y: p.y + (((a.ny + b.ny) * 0.5) * offsetPx),
    });

    if (!Number.isFinite(proj) || Math.abs(proj) < 1e-3) {
      shifted[i] = fallback();
      continue;
    }

    let miterLen = offsetPx / proj;
    if (!Number.isFinite(miterLen) || Math.abs(miterLen) > maxMiter) {
      shifted[i] = fallback();
      continue;
    }

    const ix = p.x + (jnx * miterLen);
    const iy = p.y + (jny * miterLen);
    const sx = ix - p.x;
    const sy = iy - p.y;
    const wantSign = Math.sign(offsetPx) || 1;
    const sideA = (sx * a.nx) + (sy * a.ny);
    const sideB = (sx * b.nx) + (sy * b.ny);
    if ((sideA * wantSign < -1e-6) || (sideB * wantSign < -1e-6)) {
      shifted[i] = fallback();
      continue;
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

  function normalFromCompAtNode(comp, nodeKey, routeHint, preferredBoundaryTransition = null) {
    const node = comp.nodeCoords.get(nodeKey);
    if (!node) return { nx: 0, ny: 1 };

    const candidates = (Array.isArray(routeHint) && routeHint.length)
      ? routeHint.filter((rid) => comp.routeIds.includes(rid))
      : comp.routeIds;

    let tx = 0;
    let ty = 0;
    let count = 0;
    const transitionForContext = (ctx) => {
      if (ctx.prevInComp && !ctx.nextInComp) return "split";
      if (!ctx.prevInComp && ctx.nextInComp) return "merge";
      return "inside";
    };

    for (const rid of candidates) {
      const contexts = collectRouteNodeContexts(comp, rid, nodeKey);
      for (const ctx of contexts) {
        if (preferredBoundaryTransition) {
          const tr = transitionForContext(ctx);
          if (tr !== preferredBoundaryTransition) continue;
        }
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
      if (preferredBoundaryTransition) {
        // Fall back to unrestricted contexts if no preferred-transition vectors exist.
        return normalFromCompAtNode(comp, nodeKey, routeHint, null);
      }
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

  function bubbleRouteToSide(order, rid, side) {
    const idx = order.indexOf(rid);
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

  function applyEventToOrder(order, event) {
    bubbleRouteToSide(order, event.rid, event.side);
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

    const TERMINAL_EPS = 1e-12;
    const TURN_SAMPLE_LOOKAHEAD_SHORT = 0.00025;
    const TURN_SAMPLE_LOOKAHEAD_LONG = 0.0008;

    const firstOrder = path[0].order.slice();
    const traceEventsByRoute = [];
    const stepEvents = [];

    function emitRouteBoundaryEvents({ sourceOrder, otherRouteIds, op, outEvents, outStep }) {
      const movedRoutes = sourceOrder.filter((rid) => !otherRouteIds.includes(rid));
      movedRoutes
        .map((rid) => ({ rid, idx: sourceOrder.indexOf(rid) }))
        .sort((a, b) => a.idx - b.idx)
        .forEach(({ rid, idx }) => {
          const side = sideForIndex(idx, sourceOrder.length);
          const ev = { id: rid, op, side };
          outEvents.push(ev);
          outStep.push(ev);
        });
    }

    for (let i = 1; i < path.length; i += 1) {
      const prev = path[i - 1];
      const next = path[i];
      const prevOrder = prev.order.slice();
      const nextOrder = next.order.slice();
      const perStep = [];

      emitRouteBoundaryEvents({
        sourceOrder: prevOrder,
        otherRouteIds: next.routeIds,
        op: "S",
        outEvents: traceEventsByRoute,
        outStep: perStep,
      });
      emitRouteBoundaryEvents({
        sourceOrder: nextOrder,
        otherRouteIds: prev.routeIds,
        op: "M",
        outEvents: traceEventsByRoute,
        outStep: perStep,
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
      const { nx, ny } = normalFromCompAtNode(comp, bestNode, comp.routeIds, "split");

      let obs = routeBoundaryObservation(comp, rid, bestNode, nx, ny, { requireOutside: true, preferredTransition: "split" });
      if (!obs) obs = routeBoundaryObservation(comp, rid, bestNode, nx, ny, { requireOutside: true });
      if (!obs) obs = routeBoundaryObservation(comp, rid, bestNode, nx, ny);
      if (!obs || !Number.isFinite(obs.side) || Math.abs(obs.side) < eps) return fallbackSide;
      return obs.side > 0 ? "L" : "R";
    }

    function chooseBestTerminalSplitNode(comp, routeIds) {
      const nodeStats = new Map();
      for (const rid of routeIds) {
        const seenNodesForRoute = new Set();
        for (const nodeKey of comp.nodeCoords.keys()) {
          const contexts = collectRouteNodeContexts(comp, rid, nodeKey);
          if (!contexts.length) continue;
          const splitNodeIdx = contexts
            .filter((ctx) => ctx.prevInComp && !ctx.nextInComp)
            .reduce((m, ctx) => Math.max(m, ctx.idx), -Infinity);
          if (!Number.isFinite(splitNodeIdx)) continue;
          if (seenNodesForRoute.has(nodeKey)) continue;
          seenNodesForRoute.add(nodeKey);
          let stat = nodeStats.get(nodeKey);
          if (!stat) {
            stat = { nodeKey, routeCount: 0, maxSplitNodeIdx: -Infinity };
            nodeStats.set(nodeKey, stat);
          }
          stat.routeCount += 1;
          if (splitNodeIdx > stat.maxSplitNodeIdx) stat.maxSplitNodeIdx = splitNodeIdx;
        }
      }
      const nodeCandidates = Array.from(nodeStats.values());
      if (!nodeCandidates.length) return null;
      nodeCandidates.sort((a, b) => {
        if (b.routeCount !== a.routeCount) return b.routeCount - a.routeCount;
        return b.maxSplitNodeIdx - a.maxSplitNodeIdx;
      });
      return nodeCandidates[0].nodeKey;
    }

    function complementSide(side) {
      return side === "L" ? "R" : "L";
    }

    function planarDistDeg(a, b) {
      const meanLatRad = ((a[0] + b[0]) * 0.5) * (Math.PI / 180);
      const dx = (b[1] - a[1]) * Math.cos(meanLatRad);
      const dy = (b[0] - a[0]);
      return Math.hypot(dx, dy);
    }

    function terminalSplitTurnData(comp, routeIds) {
      if (!Array.isArray(routeIds) || routeIds.length < 2) return null;
      const nodeKey = chooseBestTerminalSplitNode(comp, routeIds);
      if (!nodeKey) return null;

      const splitContextsByRoute = new Map();
      for (const rid of routeIds) {
        const contexts = collectRouteNodeContexts(comp, rid, nodeKey)
          .filter((ctx) => ctx.prevInComp && !ctx.nextInComp && ctx.prev && ctx.next);
        if (!contexts.length) continue;
        contexts.sort((a, b) => b.idx - a.idx);
        splitContextsByRoute.set(rid, contexts[0]);
      }
      if (splitContextsByRoute.size < 2) return null;

      let ux = 0;
      let uy = 0;
      let uCount = 0;
      for (const ctx of splitContextsByRoute.values()) {
        ux += (ctx.curr[1] - ctx.prev[1]);
        uy += (ctx.curr[0] - ctx.prev[0]);
        uCount += 1;
      }
      if (uCount === 0) return null;
      ux /= uCount;
      uy /= uCount;
      const uLen = Math.hypot(ux, uy);
      if (!Number.isFinite(uLen) || uLen < 1e-12) return null;
      const nx = -uy / uLen;
      const ny = ux / uLen;

      const out = new Map();
      for (const [rid, ctx] of splitContextsByRoute.entries()) {
        const seg = segmentByRouteId.get(rid);
        let samplePoint = ctx.next;
        // Look a little further downstream so tiny jitter at the split node
        // doesn't dominate side classification.
        if (seg && Array.isArray(seg.points)) {
          let prevPt = ctx.curr;
          let acc = 0;
          for (let i = ctx.idx + 1; i < seg.points.length; i += 1) {
            const p = seg.points[i];
            acc += planarDistDeg(prevPt, p);
            samplePoint = p;
            prevPt = p;
            if (acc >= TURN_SAMPLE_LOOKAHEAD_SHORT) break;
          }
        }
        if (!samplePoint) continue;

        const vx = samplePoint[1] - ctx.curr[1];
        const vy = samplePoint[0] - ctx.curr[0];
        const vLen = Math.hypot(vx, vy);
        if (!Number.isFinite(vLen) || vLen < 1e-12) continue;
        const turn = ((ux * vy) - (uy * vx)) / (uLen * vLen);
        const score = (vx * nx) + (vy * ny);
        out.set(rid, {
          turn,
          absTurn: Math.abs(turn),
          score,
          absScore: Math.abs(score),
          side: turn >= 0 ? "L" : "R",
        });
      }
      return out.size >= 2 ? out : null;
    }

    function terminalTwoRouteEdgeGeometry(comp, routeIds) {
      if (!Array.isArray(routeIds) || routeIds.length !== 2) return null;
      const lookahead = TURN_SAMPLE_LOOKAHEAD_LONG; // ~90m in lat-deg terms
      const routeMeta = [];

      for (const rid of routeIds) {
        const seg = segmentByRouteId.get(rid);
        if (!seg || !Array.isArray(seg.points) || seg.points.length < 2) return null;

        let maxSharedEdgeIdx = -1;
        for (const e of comp.edges) {
          const idx = e.firstEdgeIdxByRoute.get(rid);
          if (Number.isFinite(idx) && idx > maxSharedEdgeIdx) maxSharedEdgeIdx = idx;
        }
        if (maxSharedEdgeIdx < 0 || maxSharedEdgeIdx >= seg.points.length - 1) return null;

        const splitNodeIdx = maxSharedEdgeIdx + 1;
        if (splitNodeIdx <= 0 || splitNodeIdx >= seg.points.length) return null;

        const curr = seg.points[splitNodeIdx];
        const prev = seg.points[splitNodeIdx - 1];
        let sample = null;
        let acc = 0;
        let last = curr;
        for (let i = splitNodeIdx + 1; i < seg.points.length; i += 1) {
          const p = seg.points[i];
          acc += planarDistDeg(last, p);
          sample = p;
          last = p;
          if (acc >= lookahead) break;
        }
        if (!sample) return null;

        routeMeta.push({
          rid,
          curr,
          prev,
          sample,
        });
      }

      if (routeMeta.length !== 2) return null;

      let ux = 0;
      let uy = 0;
      for (const m of routeMeta) {
        ux += (m.curr[1] - m.prev[1]);
        uy += (m.curr[0] - m.prev[0]);
      }
      ux /= routeMeta.length;
      uy /= routeMeta.length;
      const uLen = Math.hypot(ux, uy);
      if (!Number.isFinite(uLen) || uLen < 1e-12) return null;
      const nx = -uy / uLen;
      const ny = ux / uLen;

      const scoreByRid = new Map();
      const turnByRid = new Map();
      for (const m of routeMeta) {
        const vx = m.sample[1] - m.curr[1];
        const vy = m.sample[0] - m.curr[0];
        const vLen = Math.hypot(vx, vy);
        if (!Number.isFinite(vLen) || vLen < 1e-12) return null;
        const score = (vx * nx) + (vy * ny);
        const turn = ((ux * vy) - (uy * vx)) / (uLen * vLen);
        scoreByRid.set(m.rid, score);
        turnByRid.set(m.rid, turn);
      }

      const a = routeIds[0];
      const b = routeIds[1];
      const sa = scoreByRid.get(a);
      const sb = scoreByRid.get(b);
      if (!Number.isFinite(sa) || !Number.isFinite(sb)) return null;

      const sideByRid = new Map();
      if (Math.abs(sa - sb) > TERMINAL_EPS) {
        sideByRid.set(a, sa > sb ? "L" : "R");
        sideByRid.set(b, sa > sb ? "R" : "L");
      } else {
        const ta = turnByRid.get(a);
        const tb = turnByRid.get(b);
        if (Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) > TERMINAL_EPS) {
          sideByRid.set(a, ta > tb ? "L" : "R");
          sideByRid.set(b, ta > tb ? "R" : "L");
        } else {
          return null;
        }
      }

      const strengthByRid = new Map([
        [a, Math.abs(sa)],
        [b, Math.abs(sb)],
      ]);
      return { sideByRid, strengthByRid };
    }

    function terminalTwoRouteSplitEvent(comp, routeIds, rankSides, order) {
      if (!Array.isArray(routeIds) || routeIds.length !== 2) return null;
      const leftRid = routeIds[0];
      const rightRid = routeIds[1];
      const sideByRid = new Map();
      const strengthByRid = new Map();
      const turnData = terminalSplitTurnData(comp, routeIds);
      const edgeGeom = terminalTwoRouteEdgeGeometry(comp, routeIds);

      if (edgeGeom?.sideByRid?.has(leftRid) && edgeGeom?.sideByRid?.has(rightRid)) {
        sideByRid.set(leftRid, edgeGeom.sideByRid.get(leftRid));
        sideByRid.set(rightRid, edgeGeom.sideByRid.get(rightRid));
        strengthByRid.set(leftRid, edgeGeom.strengthByRid.get(leftRid) || 0);
        strengthByRid.set(rightRid, edgeGeom.strengthByRid.get(rightRid) || 0);
      }

      if (
        sideByRid.size < 2
        && turnData
        && turnData.has(leftRid)
        && turnData.has(rightRid)
      ) {
        const a = turnData.get(leftRid);
        const b = turnData.get(rightRid);
        const hasScore = Number.isFinite(a?.score) && Number.isFinite(b?.score);
        const hasTurn = Number.isFinite(a?.turn) && Number.isFinite(b?.turn);
        if (hasScore && Math.abs(a.score - b.score) > TERMINAL_EPS) {
          sideByRid.set(leftRid, a.score > b.score ? "L" : "R");
          sideByRid.set(rightRid, a.score > b.score ? "R" : "L");
        } else if (hasTurn && Math.abs(a.turn - b.turn) > TERMINAL_EPS) {
          sideByRid.set(leftRid, a.turn > b.turn ? "L" : "R");
          sideByRid.set(rightRid, a.turn > b.turn ? "R" : "L");
        }
        if (Number.isFinite(a?.absScore)) strengthByRid.set(leftRid, a.absScore);
        if (Number.isFinite(b?.absScore)) strengthByRid.set(rightRid, b.absScore);
      }

      // Pull in ranked side observations if geometric score didn't fully resolve.
      for (const rid of routeIds) {
        if (!sideByRid.has(rid) && rankSides?.has(rid)) sideByRid.set(rid, rankSides.get(rid));
      }

      if (sideByRid.size === 1) {
        const knownRid = routeIds.find((rid) => sideByRid.has(rid));
        const otherRid = routeIds.find((rid) => rid !== knownRid);
        if (knownRid && otherRid) sideByRid.set(otherRid, complementSide(sideByRid.get(knownRid)));
      }

      if (sideByRid.size < 2) {
        const fallbackA = sideForIndex(Math.max(0, order.indexOf(leftRid)), 2);
        const fallbackB = sideForIndex(Math.max(0, order.indexOf(rightRid)), 2);
        let sideA = terminalSplitSideForRoute(comp, leftRid, fallbackA);
        let sideB = terminalSplitSideForRoute(comp, rightRid, fallbackB);
        if (sideA === sideB) sideB = complementSide(sideA);
        sideByRid.set(leftRid, sideA);
        sideByRid.set(rightRid, sideB);
      } else if (sideByRid.get(leftRid) === sideByRid.get(rightRid)) {
        sideByRid.set(rightRid, complementSide(sideByRid.get(leftRid)));
      }

      const candidates = routeIds.map((rid) => {
        const side = sideByRid.get(rid) || "L";
        const idx = Math.max(0, order.indexOf(rid));
        const target = side === "L" ? 0 : 1;
        const move = Math.abs(target - idx);
        const td = turnData?.get(rid);
        const strength = Number.isFinite(strengthByRid.get(rid))
          ? strengthByRid.get(rid)
          : (Number.isFinite(td?.absScore)
            ? td.absScore
            : (Number.isFinite(td?.absTurn) ? td.absTurn : 0));
        return { rid, side, move, strength };
      });

      candidates.sort((a, b) => {
        if (b.strength !== a.strength) return b.strength - a.strength;
        if (a.move !== b.move) return a.move - b.move;
        return String(a.rid).localeCompare(String(b.rid));
      });

      const chosen = candidates[0];
      if (!chosen) return null;
      return { id: chosen.rid, op: "S", side: chosen.side };
    }

    function terminalSplitSideByRank(comp, routeIds) {
      function terminalSplitSideByTurn(routeIdsForTurn) {
        const turnData = terminalSplitTurnData(comp, routeIdsForTurn);
        if (!turnData) return null;
        const turns = Array.from(turnData.entries()).map(([rid, info]) => ({ rid, turn: info.turn }));
        if (turns.length < 2) return null;

        // Positive cross product = left turn in lon/lat (x=east, y=north).
        turns.sort((a, b) => {
          const dt = b.turn - a.turn;
          if (dt !== 0) return dt;
          return String(a.rid).localeCompare(String(b.rid));
        });

        const out = new Map();
        const n = turns.length;
        for (let i = 0; i < n; i += 1) {
          out.set(turns[i].rid, i < (n / 2) ? "L" : "R");
        }
        return out;
      }

      const turnSides = terminalSplitSideByTurn(routeIds);
      if (turnSides) return turnSides;

      const bestNode = chooseBestTerminalSplitNode(comp, routeIds);
      if (!bestNode) return null;
      const { nx, ny } = normalFromCompAtNode(comp, bestNode, comp.routeIds, "split");

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

    function hasFutureRejoinAfterTerminalSplit(comp, splitRid, keepRid, excludedCompIds = null) {
      if (!comp || !splitRid || !keepRid) return false;
      const baseDist = compDist2Stop(comp);
      if (!Number.isFinite(baseDist)) return false;
      const eps = 1e-12;

      for (const cand of components) {
        if (!cand || cand.id === comp.id) continue;
        if (excludedCompIds && excludedCompIds.has(cand.id)) continue;
        const d = compDist2Stop(cand);
        if (!Number.isFinite(d) || d <= baseDist + eps) continue;
        if (!cand.routeIds.includes(splitRid) || !cand.routeIds.includes(keepRid)) continue;
        return true;
      }
      return false;
    }

    // Shared-overlap tracing stops at the final shared component. If multiple
    // routes are still overlapped there, represent terminal divergence by
    // splitting all but one "main" route and infer side from geometry.
    const terminalOrder = path[path.length - 1].order.slice();
    if (terminalOrder.length > 1) {
      const terminalComp = path[path.length - 1];
      const rankSides = terminalSplitSideByRank(terminalComp, terminalOrder);
      const pathCompIds = new Set(path.map((c) => c.id));

      if (terminalOrder.length === 2) {
        const ev = terminalTwoRouteSplitEvent(terminalComp, terminalOrder, rankSides, terminalOrder);
        if (ev) {
          traceEventsByRoute.push(ev);
          const keepRid = terminalOrder.find((rid) => rid !== ev.id);
          if (keepRid && hasFutureRejoinAfterTerminalSplit(terminalComp, ev.id, keepRid, pathCompIds)) {
            traceEventsByRoute.push({ id: ev.id, op: "M", side: complementSide(ev.side) });
          }
        }
      } else {
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
        bubbleRouteToSide(sim, ev.id, ev.side);
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
    const initLineOrder = masterRouteOrder.map((rid) => lineIdForRoute(rid));

    // Keep path component orders aligned with the same event replay used for
    // trace output so rendered lane ordering matches the console order.
    const replayOrder = masterRouteOrder.slice();
    for (let i = 1; i < path.length; i += 1) {
      for (const ev of (stepEvents[i - 1] || [])) bubbleRouteToSide(replayOrder, ev.id, ev.side);
      const projected = replayOrder.filter((rid) => path[i].routeIds.includes(rid));
      if (projected.length) path[i].order = projected;
    }

    // Keep non-trace downstream overlap components consistent with the full
    // event replay so rendered lane order matches the reported event/order log.
    const finalReplayOrder = masterRouteOrder.slice();
    for (const ev of traceEventsByRoute) bubbleRouteToSide(finalReplayOrder, ev.id, ev.side);
    const pathCompIdsForOrder = new Set(path.map((c) => c.id));
    const terminalPathDist = compDist2Stop(path[path.length - 1]);
    const downstreamEps = 1e-12;

    for (const comp of components) {
      if (pathCompIdsForOrder.has(comp.id)) continue;
      const d = compDist2Stop(comp);
      if (!Number.isFinite(d) || d <= terminalPathDist + downstreamEps) continue;
      const projected = finalReplayOrder.filter((rid) => comp.routeIds.includes(rid));
      if (projected.length) comp.order = projected;
    }

    const displayEvents = traceEventsByRoute.map((ev) => ({
      id: lineIdForRoute(ev.id),
      op: ev.op,
      side: ev.side,
    }));

    if (emitEvents) {
      traceOut.push({ init: initLineOrder.slice() });
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
      bubbleRouteToSide(masterRouteOrder, ev.id, ev.side);
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
    const undegCount = new Map();

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
      undegCount.set(ak, (undegCount.get(ak) || 0) + 1);
      undegCount.set(bk, (undegCount.get(bk) || 0) + 1);

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

    const edgeDirectionUnit = (edge) => {
      const a = edge.drawA || edge.a;
      const b = edge.drawB || edge.b;
      const dx = b[1] - a[1];
      const dy = b[0] - a[0];
      const len = Math.hypot(dx, dy) || 1;
      return { dx: dx / len, dy: dy / len, len };
    };

    const chooseBestNextEdge = (currEdgeIdx, candidateIdxs) => {
      if (!candidateIdxs.length) return null;
      if (candidateIdxs.length === 1) return candidateIdxs[0];

      const currDir = edgeDirectionUnit(items[currEdgeIdx].edge);
      let bestIdx = null;
      let bestScore = -Infinity;
      let bestLen = -Infinity;

      for (const idx of candidateIdxs) {
        const candDir = edgeDirectionUnit(items[idx].edge);
        const score = (currDir.dx * candDir.dx) + (currDir.dy * candDir.dy);
        if (
          score > bestScore
          || (score === bestScore && candDir.len > bestLen)
        ) {
          bestScore = score;
          bestLen = candDir.len;
          bestIdx = idx;
        }
      }

      if (bestIdx == null) return null;
      // Avoid hard U-turn continuations; in those cases end this chain and let
      // the remaining edge(s) start their own chain.
      if (bestScore < -0.2) return null;
      return bestIdx;
    };

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

        if (outs.length === 0) {
          currIdx = null;
        } else if (outs.length === 1 && indeg === 1 && outdeg === 1) {
          currIdx = outs[0];
        } else {
          currIdx = chooseBestNextEdge(currIdx, outs);
        }
      }

      if (points.length >= 2) {
        const startNodeKey = pointKey(points[0]);
        const endNodeKey = pointKey(points[points.length - 1]);
        chains.push({
          points,
          orderedRouteIds: first.orderedIds.slice(),
          colors: first.colors.slice(),
          roundCapStart: (undegCount.get(startNodeKey) || 0) <= 1,
          roundCapEnd: (undegCount.get(endNodeKey) || 0) <= 1,
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

function groupedRouteLineWidthForCount(groupCount) {
  const n = Number(groupCount) || 0;
  for (const rule of SIGN_ROUTE_LINE_WIDTH_RULES) {
    const min = Number(rule?.minGroupCount);
    const width = Number(rule?.width);
    if (!Number.isFinite(min) || !Number.isFinite(width)) continue;
    if (n >= min) return width;
  }
  return 5;
}

function stopMarkerStyleForLineWidth(lineWidthPx) {
  const targetDiameter = Math.max(1, Number(lineWidthPx) || groupedRouteLineWidthForCount(1));
  const strokeWidth = Math.max(0.35, Math.min(1.2, targetDiameter * 0.25));
  const radius = Math.max(0.45, (targetDiameter - strokeWidth) / 2);
  return { radius, strokeWidth };
}

function pointToSegmentDistanceSq(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const denom = (abx * abx) + (aby * aby);
  if (denom <= 1e-9) return (apx * apx) + (apy * apy);
  const t = Math.max(0, Math.min(1, ((apx * abx) + (apy * aby)) / denom));
  const qx = a.x + (abx * t);
  const qy = a.y + (aby * t);
  const dx = p.x - qx;
  const dy = p.y - qy;
  return (dx * dx) + (dy * dy);
}

function closestPointOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = (dx * dx) + (dy * dy);
  if (denom <= 1e-9) {
    const dpx = p.x - a.x;
    const dpy = p.y - a.y;
    return {
      x: a.x,
      y: a.y,
      t: 0,
      d2: (dpx * dpx) + (dpy * dpy),
      dx,
      dy,
      segLen: 0,
    };
  }
  const t = Math.max(0, Math.min(1, (((p.x - a.x) * dx) + ((p.y - a.y) * dy)) / denom));
  const qx = a.x + (dx * t);
  const qy = a.y + (dy * t);
  const ex = p.x - qx;
  const ey = p.y - qy;
  return {
    x: qx,
    y: qy,
    t,
    d2: (ex * ex) + (ey * ey),
    dx,
    dy,
    segLen: Math.hypot(dx, dy),
  };
}

function closestPointOnPolyline(pixelPoints, p) {
  if (!Array.isArray(pixelPoints) || pixelPoints.length < 2 || !p) return null;
  let best = null;
  for (let i = 1; i < pixelPoints.length; i += 1) {
    const a = pixelPoints[i - 1];
    const b = pixelPoints[i];
    const cand = closestPointOnSegment(p, a, b);
    if (!best || cand.d2 < best.d2) {
      best = {
        ...cand,
        segIdx: i - 1,
      };
    }
  }
  return best;
}

function buildSharedLanePlacementData(sharedChains, projectPointToPixel) {
  const byRouteId = new Map();
  if (!Array.isArray(sharedChains) || typeof projectPointToPixel !== "function") return byRouteId;

  for (const chain of sharedChains) {
    const orderedRouteIds = Array.isArray(chain?.orderedRouteIds) ? chain.orderedRouteIds : [];
    if (orderedRouteIds.length < 2 || !Array.isArray(chain?.points) || chain.points.length < 2) continue;

    const pixelPointsRaw = chain.points.map(([lat, lon]) => {
      const px = projectPointToPixel(lat, lon);
      return { x: px[0], y: px[1] };
    });
    let centerPoints = compactPixelPolyline(pixelPointsRaw);
    if (SIGN_ROUTE_GROUP_SIMPLIFY_TOLERANCE_PX > 0) {
      centerPoints = simplifyPixelPolyline(centerPoints, SIGN_ROUTE_GROUP_SIMPLIFY_TOLERANCE_PX);
    }
    if (centerPoints.length < 2) continue;

    const groupCount = orderedRouteIds.length;
    const groupedWidth = groupedRouteLineWidthForCount(groupCount);
    const laneStep = Math.max(2, groupedWidth / groupCount);
    const offsetByRouteId = new Map();
    for (let i = 0; i < orderedRouteIds.length; i += 1) {
      const rid = orderedRouteIds[i];
      const off = ((i - ((groupCount - 1) / 2)) * laneStep);
      offsetByRouteId.set(rid, off);
    }

    const meta = {
      centerPoints,
      groupedWidth,
      laneStep,
      offsetByRouteId,
    };
    for (const rid of orderedRouteIds) {
      if (!byRouteId.has(rid)) byRouteId.set(rid, []);
      byRouteId.get(rid).push(meta);
    }
  }

  return byRouteId;
}

function buildSharedLaneStateByEdgeKey(sharedEdges) {
  const byEdgeKey = new Map();
  if (!Array.isArray(sharedEdges) || sharedEdges.length === 0) return byEdgeKey;

  for (const edge of sharedEdges) {
    const orderedRouteIds = Array.isArray(edge?.orderedRouteIds) && edge.orderedRouteIds.length
      ? edge.orderedRouteIds.slice()
      : Array.from(edge?.routeIds || []).sort();
    if (orderedRouteIds.length < 2) continue;

    const groupCount = orderedRouteIds.length;
    const groupedWidth = groupedRouteLineWidthForCount(groupCount);
    const laneStep = Math.max(2, groupedWidth / groupCount);
    const laneWidthPx = Math.max(2, laneStep + SIGN_ROUTE_GROUP_LANE_OVERLAP_PX);
    const byRoute = new Map();
    for (let i = 0; i < orderedRouteIds.length; i += 1) {
      const rid = orderedRouteIds[i];
      const offsetPx = ((i - ((groupCount - 1) / 2)) * laneStep);
      byRoute.set(rid, { offsetPx, laneWidthPx, groupCount });
    }
    byEdgeKey.set(edge.key, byRoute);
  }

  return byEdgeKey;
}

function laneStateNearlyEqual(a, b) {
  if (!a || !b) return false;
  return Math.abs((a.offsetPx || 0) - (b.offsetPx || 0)) < 0.05
    && Math.abs((a.laneWidthPx || 0) - (b.laneWidthPx || 0)) < 0.05;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function smoothstep01(v) {
  const t = clamp01(v);
  return t * t * (3 - (2 * t));
}

function buildPolylineMetrics(pixelPoints) {
  if (!Array.isArray(pixelPoints) || pixelPoints.length < 2) return null;
  const pts = [];
  for (const p of pixelPoints) {
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push({ x, y });
  }
  if (pts.length < 2) return null;

  const cumulative = new Array(pts.length);
  cumulative[0] = 0;
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cumulative[i] = total;
  }
  return { points: pts, cumulative, total };
}

function polylinePointAtDistance(metrics, distancePx) {
  if (!metrics || !Array.isArray(metrics.points) || metrics.points.length < 2) return null;
  const points = metrics.points;
  const cumulative = metrics.cumulative;
  const total = Number(metrics.total) || 0;
  if (total <= 1e-9) {
    return { x: points[0].x, y: points[0].y, tx: 0, ty: -1 };
  }

  const d = Math.max(0, Math.min(total, Number(distancePx) || 0));
  let segEndIdx = 1;
  while (segEndIdx < cumulative.length && cumulative[segEndIdx] < d) segEndIdx += 1;
  if (segEndIdx >= points.length) segEndIdx = points.length - 1;

  let a = points[segEndIdx - 1];
  let b = points[segEndIdx];
  let segLen = Math.hypot(b.x - a.x, b.y - a.y);
  if (segLen <= 1e-9) {
    for (let i = segEndIdx; i < points.length - 1; i += 1) {
      const aa = points[i];
      const bb = points[i + 1];
      const ll = Math.hypot(bb.x - aa.x, bb.y - aa.y);
      if (ll > 1e-9) {
        a = aa;
        b = bb;
        segLen = ll;
        break;
      }
    }
  }
  if (segLen <= 1e-9) {
    for (let i = segEndIdx - 1; i >= 1; i -= 1) {
      const aa = points[i - 1];
      const bb = points[i];
      const ll = Math.hypot(bb.x - aa.x, bb.y - aa.y);
      if (ll > 1e-9) {
        a = aa;
        b = bb;
        segLen = ll;
        break;
      }
    }
  }
  if (segLen <= 1e-9) {
    return { x: a.x, y: a.y, tx: 0, ty: -1 };
  }

  const segStartDist = cumulative[segEndIdx - 1];
  const localT = clamp01((d - segStartDist) / segLen);
  const x = a.x + ((b.x - a.x) * localT);
  const y = a.y + ((b.y - a.y) * localT);
  const tx = (b.x - a.x) / segLen;
  const ty = (b.y - a.y) / segLen;
  return { x, y, tx, ty };
}

function polylinePointAndNormalAtDistance(metrics, distancePx) {
  if (!metrics || !Array.isArray(metrics.points) || metrics.points.length < 2) return null;
  const total = Number(metrics.total) || 0;
  if (total <= 1e-9) {
    const p = metrics.points[0];
    return { x: p.x, y: p.y, nx: 0, ny: -1 };
  }

  const d = Math.max(0, Math.min(total, Number(distancePx) || 0));
  const base = polylinePointAtDistance(metrics, d);
  if (!base) return null;

  // Smooth the normal around vertices using a short central-difference tangent.
  const normalWindowPx = Math.max(
    0.25,
    Math.min(6, (Number(SIGN_ROUTE_CONTINUITY_SAMPLE_STEP_PX) || 1.2) * 1.8),
  );
  const prev = polylinePointAtDistance(metrics, Math.max(0, d - normalWindowPx));
  const next = polylinePointAtDistance(metrics, Math.min(total, d + normalWindowPx));

  let tx = Number(base.tx) || 0;
  let ty = Number(base.ty) || -1;
  if (prev && next) {
    const vx = next.x - prev.x;
    const vy = next.y - prev.y;
    const vLen = Math.hypot(vx, vy);
    if (vLen > 1e-6) {
      tx = vx / vLen;
      ty = vy / vLen;
    }
  }

  const tLen = Math.hypot(tx, ty);
  if (tLen <= 1e-9) return { x: base.x, y: base.y, nx: 0, ny: -1 };
  return { x: base.x, y: base.y, nx: -ty / tLen, ny: tx / tLen };
}

function drawTransitionSamplesOnCanvas(ctx, color, samples) {
  if (!ctx || !color || !Array.isArray(samples) || samples.length < 2) return;
  ctx.fillStyle = color;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-4) continue;
    const nx = -dy / len;
    const ny = dx / len;
    const ar = Math.max(0.5, (Number(a.laneWidthPx) || 1) / 2);
    const br = Math.max(0.5, (Number(b.laneWidthPx) || 1) / 2);
    ctx.beginPath();
    ctx.moveTo(a.x + (nx * ar), a.y + (ny * ar));
    ctx.lineTo(b.x + (nx * br), b.y + (ny * br));
    ctx.lineTo(b.x - (nx * br), b.y - (ny * br));
    ctx.lineTo(a.x - (nx * ar), a.y - (ny * ar));
    ctx.closePath();
    ctx.fill();
  }
  for (const s of samples) {
    const r = Math.max(0.5, (Number(s?.laneWidthPx) || 1) / 2);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function buildTransitionSamplesSvg(color, samples) {
  if (!color || !Array.isArray(samples) || samples.length < 2) return [];
  const parts = [];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len <= 1e-4) continue;
    const nx = -dy / len;
    const ny = dx / len;
    const ar = Math.max(0.5, (Number(a.laneWidthPx) || 1) / 2);
    const br = Math.max(0.5, (Number(b.laneWidthPx) || 1) / 2);
    const p1x = a.x + (nx * ar);
    const p1y = a.y + (ny * ar);
    const p2x = b.x + (nx * br);
    const p2y = b.y + (ny * br);
    const p3x = b.x - (nx * br);
    const p3y = b.y - (ny * br);
    const p4x = a.x - (nx * ar);
    const p4y = a.y - (ny * ar);
    parts.push(`<polygon points="${p1x.toFixed(2)},${p1y.toFixed(2)} ${p2x.toFixed(2)},${p2y.toFixed(2)} ${p3x.toFixed(2)},${p3y.toFixed(2)} ${p4x.toFixed(2)},${p4y.toFixed(2)}" fill="${color}" />`);
  }
  for (const s of samples) {
    const r = Math.max(0.5, (Number(s?.laneWidthPx) || 1) / 2);
    parts.push(`<circle cx="${s.x.toFixed(2)}" cy="${s.y.toFixed(2)}" r="${r.toFixed(2)}" fill="${color}" />`);
  }
  return parts;
}

function drawCenterPolylineOnCanvas(ctx, pixelPoints, color, width) {
  if (!ctx || !Array.isArray(pixelPoints) || pixelPoints.length < 2 || !color) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
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

function laneStateAtDistance(edgeStates, cumulative, distancePx, fallbackState) {
  const fallback = fallbackState || { offsetPx: 0, laneWidthPx: groupedRouteLineWidthForCount(1), groupCount: 1 };
  if (!Array.isArray(edgeStates) || edgeStates.length === 0 || !Array.isArray(cumulative) || cumulative.length < 2) {
    return fallback;
  }

  const d = Number(distancePx);
  if (!Number.isFinite(d)) return edgeStates[0] || fallback;

  let idx = 0;
  while (idx < edgeStates.length - 1 && cumulative[idx + 1] <= d) idx += 1;
  return edgeStates[idx] || fallback;
}

function interpolateLaneState(fromState, toState, t) {
  const tt = clamp01(t);
  const eased = smoothstep01(tt);
  const fromOff = Number(fromState?.offsetPx) || 0;
  const toOff = Number(toState?.offsetPx) || 0;
  const fromWidth = Math.max(1, Number(fromState?.laneWidthPx) || groupedRouteLineWidthForCount(1));
  const toWidth = Math.max(1, Number(toState?.laneWidthPx) || groupedRouteLineWidthForCount(1));
  return {
    offsetPx: fromOff + ((toOff - fromOff) * eased),
    laneWidthPx: fromWidth + ((toWidth - fromWidth) * eased),
    groupCount: Number(toState?.groupCount) || Number(fromState?.groupCount) || 1,
  };
}

function laneStateAtDistanceWithTransitions(edgeStates, cumulative, transitions, distancePx, fallbackState) {
  const base = laneStateAtDistance(edgeStates, cumulative, distancePx, fallbackState);
  if (!Array.isArray(transitions) || transitions.length === 0) return base;

  const d = Number(distancePx);
  if (!Number.isFinite(d)) return base;

  let best = null;
  let bestScore = Infinity;
  for (const tr of transitions) {
    const s = Number(tr?.startDist);
    const e = Number(tr?.endDist);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    if (d < s || d > e) continue;
    const span = Math.max(1e-6, e - s);
    const center = (s + e) / 2;
    const score = Math.abs(d - center) / span;
    if (score < bestScore) {
      bestScore = score;
      best = tr;
    }
  }

  if (!best) return base;
  const span = Math.max(1e-6, Number(best.endDist) - Number(best.startDist));
  const t = (d - Number(best.startDist)) / span;
  return interpolateLaneState(best.fromState || base, best.toState || base, t);
}

function buildSegmentLaneSamples(metrics, edgeStates, transitions, options = {}) {
  if (!metrics || !Array.isArray(metrics.points) || metrics.points.length < 2) return [];
  const total = Number(metrics.total) || 0;
  if (total <= 1e-9) return [];

  const sampleStepPx = Math.max(0.4, Number(options.sampleStepPx) || Number(SIGN_ROUTE_CONTINUITY_SAMPLE_STEP_PX) || 1.2);
  const fallbackState = options.fallbackState || {
    offsetPx: 0,
    laneWidthPx: groupedRouteLineWidthForCount(1),
    groupCount: 1,
  };
  const count = Math.max(1, Math.ceil(total / sampleStepPx));
  const samples = [];

  for (let i = 0; i <= count; i += 1) {
    const d = (i === count) ? total : (i * sampleStepPx);
    const center = polylinePointAndNormalAtDistance(metrics, d);
    if (!center) continue;
    const state = laneStateAtDistanceWithTransitions(
      edgeStates,
      metrics.cumulative,
      transitions,
      d,
      fallbackState,
    );
    const off = Number(state?.offsetPx) || 0;
    const w = Math.max(1, Number(state?.laneWidthPx) || fallbackState.laneWidthPx);
    samples.push({
      x: center.x + (center.nx * off),
      y: center.y + (center.ny * off),
      laneWidthPx: w,
    });
  }

  if (samples.length < 2) return samples;
  const deduped = [samples[0]];
  for (let i = 1; i < samples.length; i += 1) {
    const p = samples[i];
    const q = deduped[deduped.length - 1];
    if (Math.hypot(p.x - q.x, p.y - q.y) > 0.05) deduped.push(p);
  }
  const compacted = deduped.length >= 2 ? deduped : samples;
  return suppressTinyCornerTriangles(compacted, SIGN_ROUTE_CORNER_TRIANGLE_REMOVE_MAX_PX);
}

function suppressTinyCornerTriangles(samples, maxTrianglePx = SIGN_ROUTE_CORNER_TRIANGLE_REMOVE_MAX_PX) {
  if (!Array.isArray(samples) || samples.length < 3) return Array.isArray(samples) ? samples : [];
  const maxPx = Math.max(0, Number(maxTrianglePx) || 0);
  if (maxPx <= 0) return samples;

  const out = samples.slice();
  const zigCrossMin = Math.max(0.25, Math.min(0.8, maxPx * 0.008));
  const zigMiddleMax = Math.max(0.9, Math.min(4.5, maxPx * 0.08));
  const zigSpikeMax = Math.max(0.35, Math.min(4.5, maxPx * 0.09));
  const maxPasses = 6;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    for (let i = 1; i < out.length - 1; ) {
      const p0 = out[i - 1];
      const p1 = out[i];
      const p2 = out[i + 1];
      if (!p0 || !p1 || !p2) {
        i += 1;
        continue;
      }

      const v1x = p1.x - p0.x;
      const v1y = p1.y - p0.y;
      const v2x = p2.x - p1.x;
      const v2y = p2.y - p1.y;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 <= 1e-4 || l2 <= 1e-4) {
        out.splice(i, 1);
        changed = true;
        continue;
      }

      // Candidate 1: very sharp tiny corner triangle.
      const dot = ((v1x * v2x) + (v1y * v2y)) / (l1 * l2);
      const spikePx = Math.sqrt(pointToSegmentDistanceSq(p1, p0, p2));
      const baseLen = Math.hypot(p2.x - p0.x, p2.y - p0.y);
      const area2 = Math.abs(((p1.x - p0.x) * (p2.y - p0.y)) - ((p1.y - p0.y) * (p2.x - p0.x)));
      const isSharpTiny = (
        dot <= 0.25
        && Number.isFinite(spikePx) && spikePx <= maxPx
        && Number.isFinite(baseLen) && baseLen <= (maxPx * 2)
        && Number.isFinite(area2) && ((area2 * 0.5) <= (maxPx * maxPx * 2))
      );
      if (isSharpTiny) {
        out.splice(i, 1);
        changed = true;
        continue;
      }

      // Candidate 2: tiny zigzag ("4") notch over two consecutive turns.
      if (i < out.length - 2) {
        const p3 = out[i + 2];
        const v3x = p3.x - p2.x;
        const v3y = p3.y - p2.y;
        const l3 = Math.hypot(v3x, v3y);
        if (l3 > 1e-4) {
          const cross1 = (v1x * v2y) - (v1y * v2x);
          const cross2 = (v2x * v3y) - (v2y * v3x);
          const flipsSide = (cross1 * cross2) < 0;
          if (
            flipsSide
            && Math.abs(cross1) >= zigCrossMin
            && Math.abs(cross2) >= zigCrossMin
            && l2 <= zigMiddleMax
          ) {
            const spike1 = spikePx;
            const spike2 = Math.sqrt(pointToSegmentDistanceSq(p2, p1, p3));
            if (
              Number.isFinite(spike1) && Number.isFinite(spike2)
              && (spike1 <= zigSpikeMax || spike2 <= zigSpikeMax)
            ) {
              const removeIdx = (spike2 < spike1) ? (i + 1) : i;
              out.splice(removeIdx, 1);
              changed = true;
              if (removeIdx === i) continue;
              i += 1;
              continue;
            }
          }
        }
      }

      i += 1;
    }
    if (!changed) break;
    if (out.length < 3) break;
  }

  return out;
}

function buildSegmentLaneTransitions(seg, pixelPoints, sharedLaneStateByEdgeKey) {
  const transitions = [];
  if (!seg || !Array.isArray(seg.points) || seg.points.length < 3 || !Array.isArray(pixelPoints) || pixelPoints.length < 3) {
    return { metrics: buildPolylineMetrics(pixelPoints), edgeStates: [], transitions };
  }

  const metrics = buildPolylineMetrics(pixelPoints);
  if (!metrics || metrics.total <= 1e-9) return { metrics, edgeStates: [], transitions };

  const transitionPx = Math.max(0, Number(SIGN_ROUTE_CONTINUITY_SMOOTHNESS_PX) || 0);
  const rid = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
  const baseState = {
    offsetPx: 0,
    laneWidthPx: groupedRouteLineWidthForCount(1),
    groupCount: 1,
  };

  const edgeStates = new Array(seg.points.length - 1);
  for (let i = 0; i < seg.points.length - 1; i += 1) {
    const eKey = edgeKey(seg.points[i], seg.points[i + 1]);
    const byRoute = sharedLaneStateByEdgeKey.get(eKey);
    edgeStates[i] = byRoute?.get(rid) || baseState;
  }
  if (transitionPx <= 0) return { metrics, edgeStates, transitions };

  for (let i = 1; i < edgeStates.length; i += 1) {
    const prevState = edgeStates[i - 1];
    const nextState = edgeStates[i];
    if (laneStateNearlyEqual(prevState, nextState)) continue;

    const vertexDist = metrics.cumulative[i];
    if (!Number.isFinite(vertexDist)) continue;

    let startDist = 0;
    let endDist = 0;
    const prevCount = Number(prevState.groupCount) || 1;
    const nextCount = Number(nextState.groupCount) || 1;
    if (prevCount > nextCount) {
      startDist = vertexDist;
      endDist = Math.min(metrics.total, vertexDist + transitionPx);
    } else if (prevCount < nextCount) {
      startDist = Math.max(0, vertexDist - transitionPx);
      endDist = vertexDist;
    } else {
      const half = transitionPx / 2;
      startDist = Math.max(0, vertexDist - half);
      endDist = Math.min(metrics.total, vertexDist + half);
    }

    if (!Number.isFinite(startDist) || !Number.isFinite(endDist) || endDist - startDist < 0.5) continue;
    transitions.push({
      startDist,
      endDist,
      fromState: prevState,
      toState: nextState,
    });
  }

  return { metrics, edgeStates, transitions };
}

function markerPixelPositionOnRouteLane(seg, marker, projectPointToPixel, segPixelPointsCache, sharedLaneByRouteId) {
  const defaultLaneWidthPx = groupedRouteLineWidthForCount(1);
  const defaultPx = projectPointToPixel(marker.lat, marker.lon);
  const p = { x: defaultPx[0], y: defaultPx[1] };
  const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
  let segPixelPoints = segPixelPointsCache.get(segKey);
  if (!segPixelPoints) {
    segPixelPoints = seg.points.map(([lat, lon]) => {
      const px = projectPointToPixel(lat, lon);
      return { x: px[0], y: px[1] };
    });
    segPixelPointsCache.set(segKey, segPixelPoints);
  }

  const onSeg = closestPointOnPolyline(segPixelPoints, p);
  let x = onSeg ? onSeg.x : p.x;
  let y = onSeg ? onSeg.y : p.y;

  const routeId = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
  const chainCandidates = sharedLaneByRouteId.get(routeId) || [];
  if (!onSeg || chainCandidates.length === 0) return { x, y, laneWidthPx: defaultLaneWidthPx };

  const anchor = { x, y };
  let best = null;
  for (const meta of chainCandidates) {
    const near = closestPointOnPolyline(meta.centerPoints, anchor);
    if (!near) continue;
    if (!best || near.d2 < best.near.d2) best = { meta, near };
  }

  if (!best) return { x, y, laneWidthPx: defaultLaneWidthPx };

  const sharedSnapPx = Math.max(10, best.meta.groupedWidth * 1.4);
  if (best.near.d2 > (sharedSnapPx * sharedSnapPx) || best.near.d2 > (onSeg.d2 + 25)) {
    return { x, y, laneWidthPx: defaultLaneWidthPx };
  }

  const laneWidthPx = Number.isFinite(best.meta.laneStep) ? best.meta.laneStep : defaultLaneWidthPx;
  const off = best.meta.offsetByRouteId.get(routeId);
  if (!Number.isFinite(off) || Math.abs(off) < 1e-9 || best.near.segLen <= 1e-6) {
    return { x: best.near.x, y: best.near.y, laneWidthPx };
  }

  const nx = -best.near.dy / best.near.segLen;
  const ny = best.near.dx / best.near.segLen;
  return {
    x: best.near.x + (nx * off),
    y: best.near.y + (ny * off),
    laneWidthPx,
  };
}

function simplifyPixelPolyline(pixelPoints, tolerancePx = 0) {
  if (!Array.isArray(pixelPoints) || pixelPoints.length < 3) {
    return Array.isArray(pixelPoints) ? pixelPoints.slice() : [];
  }
  const tol = Number(tolerancePx);
  if (!Number.isFinite(tol) || tol <= 0) return pixelPoints.slice();

  const pts = pixelPoints;
  const keep = new Array(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const tolSq = tol * tol;
  const stack = [[0, pts.length - 1]];

  while (stack.length) {
    const [startIdx, endIdx] = stack.pop();
    if (endIdx - startIdx <= 1) continue;

    let maxDistSq = -1;
    let maxIdx = -1;
    for (let i = startIdx + 1; i < endIdx; i += 1) {
      const dSq = pointToSegmentDistanceSq(pts[i], pts[startIdx], pts[endIdx]);
      if (dSq > maxDistSq) {
        maxDistSq = dSq;
        maxIdx = i;
      }
    }

    if (maxDistSq > tolSq && maxIdx > startIdx && maxIdx < endIdx) {
      keep[maxIdx] = true;
      stack.push([startIdx, maxIdx], [maxIdx, endIdx]);
    }
  }

  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    if (keep[i]) out.push(pts[i]);
  }
  return out.length >= 2 ? out : [pts[0], pts[pts.length - 1]];
}

function compactPixelPolyline(pixelPoints, minDistPx = 0.05) {
  if (!Array.isArray(pixelPoints) || pixelPoints.length < 2) return Array.isArray(pixelPoints) ? pixelPoints.slice() : [];
  const out = [pixelPoints[0]];
  for (let i = 1; i < pixelPoints.length; i += 1) {
    const p = pixelPoints[i];
    const q = out[out.length - 1];
    if (Math.hypot(p.x - q.x, p.y - q.y) >= minDistPx) out.push(p);
  }
  if (out.length < 2) return [pixelPoints[0], pixelPoints[pixelPoints.length - 1]];
  return out;
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
  let centerPoints = compactPixelPolyline(pixelPoints);
  const simplifyTolerancePx = Number.isFinite(options.simplifyTolerancePx) ? Math.max(0, options.simplifyTolerancePx) : 0;
  if (simplifyTolerancePx > 0) centerPoints = simplifyPixelPolyline(centerPoints, simplifyTolerancePx);
  if (centerPoints.length < 2) return;
  if (colors.length === 1) {
    ctx.strokeStyle = colors[0];
    ctx.lineWidth = width;
    ctx.lineCap = lineCap;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < centerPoints.length; i += 1) {
      const p = centerPoints[i];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    return;
  }

  const laneStep = Math.max(2, width / colors.length);
  const laneOverlapPx = Number.isFinite(options.laneOverlapPx) ? options.laneOverlapPx : 0;
  const laneWidth = Math.max(2, laneStep + laneOverlapPx);
  const roundCapStart = !!options.roundCapStart;
  const roundCapEnd = !!options.roundCapEnd;
  for (let i = 0; i < colors.length; i += 1) {
    const off = ((i - ((colors.length - 1) / 2)) * laneStep);
    let shifted = offsetPolylinePixels(centerPoints, off);
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

    if (lineCap === "butt" && (roundCapStart || roundCapEnd)) {
      const r = laneWidth / 2;
      ctx.fillStyle = colors[i];
      if (roundCapStart) {
        const s = shifted[0];
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (roundCapEnd) {
        const e = shifted[shifted.length - 1];
        ctx.beginPath();
        ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
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
  const pad = 1.02;
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

function computeSignMapViewWindow(bounds, width, height, tileZoomOffset = 0) {
  const renderZoom = chooseMapZoom(bounds, width, height);
  const baseTileZoom = Math.max(0, Math.floor(renderZoom));
  const tileZoom = Math.max(0, Math.min(19, baseTileZoom + tileZoomOffset));
  const scale = 2 ** (renderZoom - tileZoom);
  const centerLat = (bounds.minLat + bounds.maxLat) / 2;
  const centerLon = (bounds.minLon + bounds.maxLon) / 2;
  const centerTileWorld = latLonToWorld(centerLat, centerLon, tileZoom);
  const centerWorld = { x: centerTileWorld.x * scale, y: centerTileWorld.y * scale };
  const left = centerWorld.x - (width / 2);
  const top = centerWorld.y - (height / 2);
  const right = centerWorld.x + (width / 2);
  const bottom = centerWorld.y + (height / 2);
  const tileSize = 256 * scale;
  const x0 = Math.floor(left / tileSize);
  const y0 = Math.floor(top / tileSize);
  const x1 = Math.floor(right / tileSize);
  const y1 = Math.floor(bottom / tileSize);

  return {
    renderZoom,
    baseTileZoom,
    tileZoom,
    tileZoomOffset,
    scale,
    centerLat,
    centerLon,
    centerWorld,
    left,
    top,
    right,
    bottom,
    tileSize,
    x0,
    y0,
    x1,
    y1,
  };
}

function deepCloneJson(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function scaleTextSizeSpec(spec, factor) {
  if (typeof spec === "number") return spec * factor;
  if (!Array.isArray(spec)) return spec;

  const out = spec.slice();
  const op = out[0];
  if (op === "interpolate") {
    for (let i = 4; i < out.length; i += 2) {
      if (typeof out[i] === "number") out[i] *= factor;
    }
    return out;
  }
  if (op === "step") {
    for (let i = 2; i < out.length; i += 2) {
      if (typeof out[i] === "number") out[i] *= factor;
    }
    return out;
  }
  return out;
}

function scaledMinZoom(minzoom, delta) {
  if (!Number.isFinite(minzoom)) return minzoom;
  return Math.max(0, minzoom + delta);
}

function isLikelyRoadLabelLayer(layer) {
  const id = String(layer?.id || "").toLowerCase();
  const sourceLayer = String(layer?.["source-layer"] || "").toLowerCase();
  const txt = `${id} ${sourceLayer}`;
  const hasRoadToken = /road|street|highway|motorway|trunk|primary|secondary|tertiary/.test(txt);
  const isShield = /shield|ref|number/.test(txt);
  return hasRoadToken && !isShield;
}

async function loadSignVectorStyle() {
  if (signVectorStylePromise) return signVectorStylePromise;
  signVectorStylePromise = (async () => {
    const res = await fetch(SIGN_VECTOR_STYLE_URL, { cache: "force-cache" });
    if (!res.ok) throw new Error(`Vector style load failed: ${res.status}`);
    const baseStyle = await res.json();
    const style = deepCloneJson(baseStyle);
    if (!Array.isArray(style.layers)) return style;

    signVectorRoadLabelBaseSizeByLayer = new Map();
    signVectorRoadLabelLastFactor = null;

    for (const layer of style.layers) {
      if (!layer || layer.type !== "symbol") continue;
      const layout = layer.layout || {};
      if (layout["text-field"] == null) continue;
      const isRoadLabel = isLikelyRoadLabelLayer(layer);
      const sizeScale = isRoadLabel ? SIGN_VECTOR_ROAD_LABEL_SIZE_SCALE : SIGN_VECTOR_NON_ROAD_LABEL_SIZE_SCALE;
      const scaledTextSize = scaleTextSizeSpec(
        layout["text-size"] ?? 12,
        sizeScale,
      );

      const nextLayout = {
        ...layout,
        "text-size": scaledTextSize,
      };
      if (isRoadLabel) {
        // Increase road-name density without changing route geometry zoom.
        nextLayout["text-allow-overlap"] = true;
        nextLayout["text-ignore-placement"] = true;
        if (typeof nextLayout["symbol-spacing"] === "number") {
          nextLayout["symbol-spacing"] = Math.max(40, nextLayout["symbol-spacing"] / SIGN_VECTOR_ROAD_LABEL_DENSITY_SCALE);
        } else {
          nextLayout["symbol-spacing"] = Math.max(40, 80 / SIGN_VECTOR_ROAD_LABEL_DENSITY_SCALE);
        }

        layer.paint = {
          ...(layer.paint || {}),
          "text-color": SIGN_VECTOR_ROAD_LABEL_COLOR,
          "text-halo-color": SIGN_VECTOR_ROAD_LABEL_HALO_COLOR,
          "text-halo-width": SIGN_VECTOR_ROAD_LABEL_HALO_WIDTH,
        };

        if (layer.id) {
          signVectorRoadLabelBaseSizeByLayer.set(layer.id, deepCloneJson(scaledTextSize));
        }
      }

      layer.layout = nextLayout;
      if (isRoadLabel && Number.isFinite(layer.minzoom)) {
        layer.minzoom = scaledMinZoom(layer.minzoom, SIGN_VECTOR_ROAD_LABEL_MINZOOM_SHIFT);
      }
    }

    return style;
  })();
  return signVectorStylePromise;
}

function roadLabelZoomCompensationFactor(renderZoom) {
  if (!Number.isFinite(renderZoom)) return 1;
  const raw = 2 ** ((SIGN_VECTOR_ROAD_LABEL_REFERENCE_ZOOM - renderZoom) * SIGN_VECTOR_ROAD_LABEL_ZOOM_COMPENSATION);
  return Math.max(
    SIGN_VECTOR_ROAD_LABEL_MIN_FACTOR,
    Math.min(SIGN_VECTOR_ROAD_LABEL_MAX_FACTOR, raw),
  );
}

function applyRoadLabelZoomCompensation(mapObj, renderZoom) {
  if (!mapObj || signVectorRoadLabelBaseSizeByLayer.size === 0) return 1;
  const factor = roadLabelZoomCompensationFactor(renderZoom);
  if (Number.isFinite(signVectorRoadLabelLastFactor) && Math.abs(signVectorRoadLabelLastFactor - factor) < 1e-3) {
    return factor;
  }

  for (const [layerId, baseTextSize] of signVectorRoadLabelBaseSizeByLayer.entries()) {
    if (!mapObj.getLayer(layerId)) continue;
    mapObj.setLayoutProperty(layerId, "text-size", scaleTextSizeSpec(baseTextSize, factor));
  }

  signVectorRoadLabelLastFactor = factor;
  return factor;
}

function ensureSignVectorMapHost(width, height) {
  const cssW = Math.max(1, Math.round(width));
  const cssH = Math.max(1, Math.round(height));
  if (!signVectorMapHost) {
    const host = document.createElement("div");
    host.id = "signVectorMapHost";
    host.style.position = "fixed";
    host.style.left = "-20000px";
    host.style.top = "0";
    host.style.opacity = "0";
    host.style.pointerEvents = "none";
    host.style.zIndex = "-1";
    host.style.overflow = "hidden";
    signVectorMapHost = host;
    document.body.appendChild(signVectorMapHost);
  }
  signVectorMapHost.style.width = `${cssW}px`;
  signVectorMapHost.style.height = `${cssH}px`;
  return signVectorMapHost;
}

function waitForMapIdle(mapObj, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const tilesLoadedNow = () => {
      if (!mapObj?.loaded?.()) return false;
      if (typeof mapObj.areTilesLoaded === "function") return !!mapObj.areTilesLoaded();
      return true;
    };
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      mapObj.off("idle", onIdle);
      resolve({
        reason,
        timedOut: reason === "timeout",
        tilesLoaded: tilesLoadedNow(),
      });
    };
    const onIdle = () => finish("idle");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    mapObj.once("idle", onIdle);

    if (tilesLoadedNow()) {
      requestAnimationFrame(() => finish("already-loaded"));
    }
  });
}

async function ensureSignVectorMap(width, height) {
  if (signVectorUnavailable) return null;
  const maplibre = window.maplibregl;
  if (!maplibre?.Map) return null;

  const host = ensureSignVectorMapHost(width, height);
  if (!signVectorMap) {
    const style = await loadSignVectorStyle();
    signVectorMap = new maplibre.Map({
      container: host,
      style,
      interactive: false,
      attributionControl: false,
      preserveDrawingBuffer: true,
      fadeDuration: 0,
      pitch: 0,
      bearing: 0,
    });
    await waitForMapIdle(signVectorMap);
  } else {
    signVectorMap.resize();
  }
  return signVectorMap;
}

async function renderVectorBasemapSnapshot({ bounds, width, height }) {
  if (signVectorUnavailable) return null;
  try {
    const mapObj = await ensureSignVectorMap(width, height);
    if (!mapObj) return null;

    const view = computeSignMapViewWindow(bounds, width, height, 0);
    const roadLabelZoomFactor = applyRoadLabelZoomCompensation(mapObj, view.renderZoom);
    const glZoom = Math.max(0, view.renderZoom + SIGN_VECTOR_GL_ZOOM_OFFSET);
    mapObj.resize();
    mapObj.jumpTo({
      center: [view.centerLon, view.centerLat],
      zoom: glZoom,
      bearing: 0,
      pitch: 0,
    });
    const idleState = await waitForMapIdle(mapObj);

    const src = mapObj.getCanvas();
    if (!src || src.width <= 0 || src.height <= 0) return null;

    const snapshot = document.createElement("canvas");
    snapshot.width = src.width;
    snapshot.height = src.height;
    const sctx = snapshot.getContext("2d");
    sctx.drawImage(src, 0, 0);
    return {
      canvas: snapshot,
      view,
      roadLabelZoomFactor,
      fullyLoaded: idleState?.tilesLoaded !== false,
      idleState,
    };
  } catch (err) {
    console.warn("Vector sign basemap unavailable, using raster fallback.", err);
    signVectorUnavailable = true;
    return null;
  }
}

function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function expandTileTemplate(url, { z, x, y, subdomain = "a", retinaSuffix = "" }) {
  return url
    .replace("{s}", subdomain)
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y))
    .replace("{r}", retinaSuffix);
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

async function drawRasterBasemapTilesOnCanvas(ctx, { x, y, w, h, bounds }) {
  const view = computeSignMapViewWindow(bounds, w, h, SIGN_BASEMAP_TILE_ZOOM_OFFSET);
  const {
    tileZoom,
    left,
    top,
    tileSize,
    x0,
    y0,
    x1,
    y1,
  } = view;
  let requestedTiles = 0;
  let failedTiles = 0;

  const draws = [];
  for (let tx = x0; tx <= x1; tx += 1) {
    for (let ty = y0; ty <= y1; ty += 1) {
      requestedTiles += 1;
      draws.push((async () => {
        try {
          const img = await loadTileImage(tileZoom, tx, ty, "base");
          const px = x + ((tx * tileSize) - left);
          const py = y + ((ty * tileSize) - top);
          ctx.drawImage(img, px, py, tileSize, tileSize);
        } catch {
          failedTiles += 1;
          // Best-effort tiles; continue rendering.
        }
      })());
    }
  }
  await Promise.all(draws);

  const labelDraws = [];
  for (let tx = x0; tx <= x1; tx += 1) {
    for (let ty = y0; ty <= y1; ty += 1) {
      requestedTiles += 1;
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
          failedTiles += 1;
          // Best-effort tiles; continue rendering.
        }
      })());
    }
  }
  await Promise.all(labelDraws);

  return {
    mode: "raster",
    requestedTiles,
    failedTiles,
    fullyLoaded: failedTiles === 0,
  };
}

async function drawBasemapTilesOnCanvas(ctx, { x, y, w, h, bounds }) {
  const vectorSnapshot = await renderVectorBasemapSnapshot({ bounds, width: w, height: h });
  if (vectorSnapshot?.canvas) {
    ctx.save();
    ctx.globalAlpha = SIGN_BASEMAP_OPACITY;
    ctx.drawImage(vectorSnapshot.canvas, x, y, w, h);
    ctx.restore();
    return {
      mode: "vector",
      fullyLoaded: vectorSnapshot.fullyLoaded !== false,
      idleState: vectorSnapshot.idleState || null,
    };
  }
  return drawRasterBasemapTilesOnCanvas(ctx, { x, y, w, h, bounds });
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

async function drawRoutePreviewOnCanvas(ctx, {
  x, y, w, h, stop, segments, renderToken, showStops = false, routeStopMarkersBySegment = null,
}) {
  const mapCfg = SIGN_TEMPLATE.map;
  const legendCfg = SIGN_TEMPLATE.legend;
  const colorCfg = SIGN_TEMPLATE.colors;
  const typeCfg = SIGN_TEMPLATE.typography;
  const stopLat = safeParseFloat(stop.stop_lat);
  const stopLon = safeParseFloat(stop.stop_lon);

  ctx.fillStyle = mapCfg.outerFill;
  roundRect(ctx, x, y, w, h, mapCfg.outerRadius, true, false);
  ctx.strokeStyle = mapCfg.outerStroke;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, mapCfg.outerRadius, false, true);

  if (segments.length === 0) {
    ctx.fillStyle = colorCfg.noRouteMessage;
    ctx.font = signCanvasFont(typeCfg.noRouteMessage);
    ctx.fillText(
      "No route geometry available for this stop/direction.",
      x + mapCfg.noRouteMessageXOffset,
      y + Math.floor(h / 2),
    );
    return {
      basemapReady: true,
      basemapMode: "none",
    };
  }

  const {
    drawSegments,
    legendEntries,
    mergedRouteStopMarkersBySegment,
  } = buildSharedStopPatternRenderPlan(segments, routeStopMarkersBySegment);
  const markersBySegment = (mergedRouteStopMarkersBySegment instanceof Map && mergedRouteStopMarkersBySegment.size > 0)
    ? mergedRouteStopMarkersBySegment
    : routeStopMarkersBySegment;
  const orderedLegendEntries = sortedLegendEntries(legendEntries);
  const pad = mapCfg.innerPad;
  const legendH = signLegendHeight(orderedLegendEntries);
  const drawX = x + pad;
  const drawY = y + pad;
  const drawW = w - (pad * 2);
  const drawH = h - (pad * 2) - legendH;
  const bounds = getRouteBounds(stop, drawSegments);

  ctx.save();
  ctx.beginPath();
  roundRect(ctx, drawX, drawY, drawW, drawH, mapCfg.clipRadius, false, false);
  ctx.clip();
  const basemapStatus = await drawBasemapTilesOnCanvas(ctx, { x: drawX, y: drawY, w: drawW, h: drawH, bounds });
  ctx.restore();

  if (renderToken !== signRenderToken) {
    return {
      basemapReady: false,
      basemapMode: basemapStatus?.mode || "unknown",
      aborted: true,
    };
  }

  const { project } = makeCanvasProjector(bounds, drawX, drawY, drawW, drawH);
  const sharedEdges = buildSharedEdges(drawSegments, stop);
  const sharedChains = buildSharedLaneChains(sharedEdges);
  const sharedLaneByRouteId = buildSharedLanePlacementData(
    sharedChains,
    (lat, lon) => project(lat, lon),
  );
  const sharedLaneStateByEdgeKey = buildSharedLaneStateByEdgeKey(sharedEdges);
  const segPixelPointsCache = new Map();
  const transitionBySegKey = new Map();

  for (const seg of drawSegments) {
    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    let segPixelPoints = segPixelPointsCache.get(segKey);
    if (!segPixelPoints) {
      segPixelPoints = seg.points.map(([lat, lon]) => {
        const [px, py] = project(lat, lon);
        return { x: px, y: py };
      });
      segPixelPointsCache.set(segKey, segPixelPoints);
    }
    transitionBySegKey.set(
      segKey,
      buildSegmentLaneTransitions(seg, segPixelPoints, sharedLaneStateByEdgeKey),
    );
  }

  for (const seg of drawSegments) {
    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    const segTransition = transitionBySegKey.get(segKey);
    const metrics = segTransition?.metrics;
    const transitions = Array.isArray(segTransition?.transitions) ? segTransition.transitions : [];
    const edgeStates = Array.isArray(segTransition?.edgeStates) ? segTransition.edgeStates : [];
    if (!metrics || !Array.isArray(metrics.cumulative) || !Number.isFinite(metrics.total) || metrics.total <= 0) {
      const fallbackPts = seg.points.map(([lat, lon]) => {
        const [px, py] = project(lat, lon);
        return { x: px, y: py };
      });
      drawCenterPolylineOnCanvas(ctx, fallbackPts, seg.lineColor, groupedRouteLineWidthForCount(1));
      continue;
    }

    const fallbackState = { offsetPx: 0, laneWidthPx: groupedRouteLineWidthForCount(1), groupCount: 1 };
    const samples = buildSegmentLaneSamples(metrics, edgeStates, transitions, { fallbackState });
    if (samples.length >= 2) drawTransitionSamplesOnCanvas(ctx, seg.lineColor, samples);
  }

  if (showStops && markersBySegment instanceof Map) {
    for (const seg of drawSegments) {
      const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
      const stopsForSeg = markersBySegment.get(segKey) || [];
      if (!stopsForSeg.length) continue;

      ctx.fillStyle = seg.lineColor;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      for (const s of stopsForSeg) {
        const pos = markerPixelPositionOnRouteLane(
          seg,
          s,
          (lat, lon) => project(lat, lon),
          segPixelPointsCache,
          sharedLaneByRouteId,
        );
        const markerStyle = stopMarkerStyleForLineWidth(pos.laneWidthPx);
        const px = pos.x;
        const py = pos.y;
        ctx.lineWidth = markerStyle.strokeWidth;
        ctx.beginPath();
        ctx.arc(px, py, markerStyle.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  if (stopLat != null && stopLon != null) {
    const [px, py] = project(stopLat, stopLon);
    ctx.fillStyle = colorCfg.stopMarkerFill;
    ctx.strokeStyle = colorCfg.stopMarkerStroke;
    ctx.lineWidth = SIGN_TEMPLATE.marker.stopStrokeWidth;
    ctx.beginPath();
    ctx.arc(px, py, SIGN_TEMPLATE.marker.stopRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  const legendX = x + legendCfg.xInset;
  const lineH = legendCfg.lineHeight;
  const itemGap = legendCfg.itemGap;
  let legendY = y + h - legendH + legendCfg.startBaselineOffset;
  const legendFontBold = signCanvasFont(typeCfg.legendBold);
  const legendFontRegular = signCanvasFont(typeCfg.legendRegular);
  const legendMaxChars = legendCfg.maxInlineChars;
  for (const seg of orderedLegendEntries.slice(0, legendCfg.maxItems)) {
    const lines = buildLegendLinesForSegment(seg);
    const routeLabel = (seg.display_name || seg.route_short_name || "Route").toString().trim();
    const activeLabel = (seg.active_hours_text || "").toString().trim();
    const combined = activeLabel ? `${routeLabel} ${activeLabel}`.trim() : routeLabel;
    const swatchW = legendCfg.swatchWidth;
    ctx.fillStyle = seg.lineColor;
    roundRect(
      ctx,
      legendX,
      legendY - legendCfg.swatchTopOffset,
      swatchW,
      legendCfg.swatchHeight,
      legendCfg.swatchRadius,
      true,
      false,
    );
    ctx.fillStyle = colorCfg.legendText;
    const textX = legendX + swatchW + legendCfg.textGap;

    if (activeLabel && combined.length <= legendMaxChars) {
      ctx.font = legendFontBold;
      ctx.fillText(routeLabel, textX, legendY);
      const routeW = ctx.measureText(routeLabel).width;
      ctx.font = legendFontRegular;
      ctx.fillText(` ${activeLabel}`, textX + routeW, legendY);
      legendY += lineH;
    } else {
      ctx.font = legendFontBold;
      ctx.fillText(lines[0] || routeLabel, textX, legendY);
      legendY += lineH;
      for (let i = 1; i < lines.length; i += 1) {
        ctx.font = legendFontRegular;
        ctx.fillText(lines[i], textX, legendY);
        legendY += lineH;
      }
    }
    legendY += itemGap;
    if (legendY > y + h - legendCfg.bottomGuard) break;
  }

  return {
    basemapReady: basemapStatus?.fullyLoaded !== false,
    basemapMode: basemapStatus?.mode || "unknown",
  };
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
    const serviceWeekdays = serviceActiveWeekdaysById.get(t.service_id);
    if (hasServiceCalendarData && (!serviceWeekdays || serviceWeekdays.size === 0)) continue;

    const dir = (t.direction_id === "" || t.direction_id == null) ? null : String(t.direction_id);
    if (directionFilter !== "all" && String(dir) !== String(directionFilter)) continue;

    const route = routesById.get(t.route_id);
    if (!route) continue;

    const headsign = (t.trip_headsign && String(t.trip_headsign).trim()) || (route.route_long_name || route.route_short_name || "");
    const shapeIdForKey = String(t.shape_id ?? "").trim();
    const k = `${t.route_id}||${dir ?? ""}||${shapeIdForKey}||${headsign}`;
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
      if (serviceWeekdays && serviceWeekdays.size > 0) {
        for (const weekdayRaw of serviceWeekdays) {
          const weekday = Number(weekdayRaw);
          if (!Number.isFinite(weekday)) continue;
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
    return {
      route_id: x.route_id,
      direction_id: x.direction_id,
      headsign,
      count: x.count,
      shape_id: shapeId,
      route_short_name: shortName,
      route_color: normalizeColor(r?.route_color, "#3b82f6"),
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

function normalizeDirectionId(v) {
  if (v == null || v === "") return null;
  return String(v);
}

function normalizePreloadedSummaryItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const routeId = raw.route_id;
  if (!routeId) return null;
  const countRaw = Number.parseInt(raw.count, 10);
  return {
    route_id: String(routeId),
    direction_id: normalizeDirectionId(raw.direction_id),
    headsign: String(raw.headsign || ""),
    count: Number.isFinite(countRaw) ? countRaw : 0,
    shape_id: raw.shape_id ? String(raw.shape_id) : null,
    route_short_name: String(raw.route_short_name || ""),
    route_color: normalizeColor(raw.route_color, "#3b82f6"),
    active_hours_text: String(raw.active_hours_text || ""),
  };
}

function decodeCompactPreloadedSummaryItem(row, fieldIndexByName) {
  if (!Array.isArray(row)) return null;
  const read = (fieldName, fallback = null) => {
    const idx = fieldIndexByName.get(fieldName);
    if (!Number.isFinite(idx) || idx < 0 || idx >= row.length) return fallback;
    const v = row[idx];
    return v == null ? fallback : v;
  };

  const routeId = read("route_id", "");
  if (!routeId) return null;
  const countRaw = Number.parseInt(read("count", 0), 10);
  return {
    route_id: String(routeId),
    direction_id: normalizeDirectionId(read("direction_id", null)),
    headsign: String(read("headsign", "")),
    count: Number.isFinite(countRaw) ? countRaw : 0,
    shape_id: read("shape_id", null) ? String(read("shape_id", null)) : null,
    route_short_name: String(read("route_short_name", "")),
    route_color: normalizeColor(read("route_color", "#3b82f6"), "#3b82f6"),
    active_hours_text: String(read("active_hours_text", "")),
  };
}

function normalizePreloadedSummaryItems(rawItems, itemFields = PRELOADED_SUMMARY_COMPACT_ITEM_FIELDS) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return [];

  const fields = (Array.isArray(itemFields) && itemFields.length)
    ? itemFields
    : PRELOADED_SUMMARY_COMPACT_ITEM_FIELDS;
  const fieldIndexByName = new Map();
  for (let i = 0; i < fields.length; i += 1) fieldIndexByName.set(String(fields[i]), i);

  const out = [];
  for (const raw of rawItems) {
    const item = Array.isArray(raw)
      ? decodeCompactPreloadedSummaryItem(raw, fieldIndexByName)
      : normalizePreloadedSummaryItem(raw);
    if (item) out.push(item);
  }
  return out;
}

function summaryItemsForDirection(items, directionFilter) {
  if (!Array.isArray(items)) return [];
  if (directionFilter === "all") return items;
  const wanted = String(directionFilter);
  return items.filter((item) => String(item?.direction_id ?? "") === wanted);
}

function loadRouteSummaryCacheFromData(preloadData) {
  if (!preloadData || typeof preloadData !== "object") return false;
  const stopsObj = preloadData.stops;
  if (!stopsObj || typeof stopsObj !== "object") return false;

  const nextCache = new Map();
  const nextStopOverlays = new Map();
  const version = Number.parseInt(preloadData.version, 10) || 1;
  if (version >= 2) {
    const itemFields = Array.isArray(preloadData.item_fields)
      ? preloadData.item_fields
      : PRELOADED_SUMMARY_COMPACT_ITEM_FIELDS;
    for (const [stopId, rawItems] of Object.entries(stopsObj)) {
      if (!stopId) continue;
      const items = normalizePreloadedSummaryItems(rawItems, itemFields);
      if (items.length === 0) continue;
      nextCache.set(routeSummaryCacheKey(stopId, "all"), items);
    }
  } else {
    const directions = ["all", "0", "1"];
    for (const [stopId, byDirection] of Object.entries(stopsObj)) {
      if (!stopId || !byDirection || typeof byDirection !== "object") continue;
      for (const dir of directions) {
        const items = normalizePreloadedSummaryItems(byDirection[dir], PRELOADED_SUMMARY_COMPACT_ITEM_FIELDS);
        if (items.length === 0) continue;
        nextCache.set(routeSummaryCacheKey(stopId, dir), items);
      }
    }
  }

  if (nextCache.size === 0) return false;

  const rawStopOverlays = preloadData.stop_overlays;
  if (rawStopOverlays && typeof rawStopOverlays === "object") {
    for (const [stopId, byRouteShape] of Object.entries(rawStopOverlays)) {
      if (!stopId || !byRouteShape || typeof byRouteShape !== "object") continue;
      const byShapeMap = new Map();
      for (const [routeShapeKey, stopIds] of Object.entries(byRouteShape)) {
        if (!routeShapeKey || !Array.isArray(stopIds)) continue;
        byShapeMap.set(routeShapeKey, stopIds.map((sid) => String(sid)));
      }
      if (byShapeMap.size > 0) {
        nextStopOverlays.set(String(stopId), byShapeMap);
      }
    }
  }

  routeSummaryCache = nextCache;
  preloadedStopOverlayByStop = nextStopOverlays;
  return true;
}

async function tryLoadPreloadedRouteSummaries() {
  try {
    const res = await fetch(PRELOADED_SUMMARY_URL, { cache: "no-cache" });
    if (!res.ok) return false;
    const preloadData = await res.json();
    const version = Number.parseInt(preloadData?.version, 10) || 1;
    if (version >= 2 && version < PRELOADED_SUMMARY_MIN_VERSION) {
      console.warn(
        `Preloaded summaries v${version} are stale for active-hours accuracy; rebuilding from GTFS stop_times.`,
      );
      return false;
    }
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
      serviceActiveWeekdaysById: mapToObject(serviceActiveWeekdaysById, (set) => Array.from(set)),
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

  if (directionFilter !== "all") {
    const allItems = routeSummaryCache.get(routeSummaryCacheKey(stop.stop_id, "all"));
    if (allItems !== undefined) {
      const filtered = summaryItemsForDirection(allItems, directionFilter);
      routeSummaryCache.set(key, filtered);
      return filtered;
    }
  }

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

async function drawSign({
  stop,
  items,
  directionFilter,
  maxRoutes,
  renderToken,
  outputScale = 1,
  showStops = false,
}) {
  const canvas = ui.signCanvas;
  const ctx = canvas.getContext("2d");
  const layout = getSignLayoutGeometry({
    width: SIGN_TEMPLATE.size.width,
    height: SIGN_TEMPLATE.size.height,
  });
  const colorCfg = SIGN_TEMPLATE.colors;
  const typeCfg = SIGN_TEMPLATE.typography;

  const scale = Math.max(1, Math.min(3, Number(outputScale) || 1));

  // Logical sign size
  const W = layout.width;
  const H = layout.height;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);

  // Background
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Header area
  const pad = layout.pad;
  const qrLayout = layout.qrLayout;

  ctx.fillStyle = colorCfg.title;
  ctx.font = signCanvasFont(typeCfg.title);
  ctx.fillText(SIGN_TEMPLATE.labels.title, pad, layout.titleBaselineY);

  // Stop code / id
  const code = stop.stop_code ? `#${stop.stop_code}` : `#${stop.stop_id}`;
  ctx.font = signCanvasFont(typeCfg.code);
  ctx.fillStyle = colorCfg.code;
  ctx.fillText(code, pad, layout.codeBaselineY);

  ctx.fillStyle = colorCfg.qrFrameFill;
  ctx.strokeStyle = colorCfg.qrFrameStroke;
  ctx.lineWidth = SIGN_TEMPLATE.header.qrFrameStrokeWidth;
  roundRect(
    ctx,
    qrLayout.frameX,
    qrLayout.frameY,
    qrLayout.frameSize,
    qrLayout.frameSize,
    SIGN_TEMPLATE.header.qrFrameRadius,
    true,
    true,
  );

  let qrDataUrl = "";
  try {
    qrDataUrl = await getStopQrCodeDataUrl(stop);
  } catch (err) {
    console.warn("Failed to generate stop QR code.", err);
  }
  if (renderToken !== signRenderToken) {
    return { basemapReady: false, basemapMode: "unknown", aborted: true };
  }

  if (qrDataUrl) {
    try {
      const qrImg = await loadImageFromSource(qrDataUrl);
      if (renderToken !== signRenderToken) {
        return { basemapReady: false, basemapMode: "unknown", aborted: true };
      }
      ctx.drawImage(qrImg, qrLayout.x, qrLayout.y, qrLayout.size, qrLayout.size);
    } catch (err) {
      console.warn("Failed to load stop QR image.", err);
      drawHeaderQrFallbackOnCanvas(ctx, qrLayout);
    }
  } else {
    drawHeaderQrFallbackOnCanvas(ctx, qrLayout);
  }

  ctx.fillStyle = colorCfg.qrCaption;
  ctx.font = signCanvasFont(typeCfg.qrCaption);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < SIGN_TEMPLATE.labels.qrCaptionLines.length; i += 1) {
    const y = qrLayout.captionStartY + (i * SIGN_TEMPLATE.header.qrCaptionLineHeight);
    ctx.fillText(SIGN_TEMPLATE.labels.qrCaptionLines[i], qrLayout.captionX, y);
  }
  ctx.textAlign = "left";

  // Stop name / direction label
  const subtitle = `${stop.stop_name || "—"}`;
  ctx.fillStyle = colorCfg.subtitle;
  ctx.font = signCanvasFont(typeCfg.subtitle);
  ctx.fillText(subtitle, pad, layout.subtitleBaselineY);

  const routeSegments = buildRouteSegmentsForStop(stop, items, maxRoutes);
  let routeStopMarkersBySegment = null;
  try {
    routeStopMarkersBySegment = await getRouteStopMarkersBySegment(stop, routeSegments);
  } catch (err) {
    console.warn("Failed to load route stop markers for sign preview.", err);
    routeStopMarkersBySegment = null;
  }
  if (renderToken !== signRenderToken) {
    return { basemapReady: false, basemapMode: "unknown", aborted: true };
  }

  // Route map preview (this is rendered into the PNG)
  ctx.fillStyle = colorCfg.mapTitle;
  ctx.font = signCanvasFont(typeCfg.mapTitle);
  ctx.fillText(SIGN_TEMPLATE.labels.mapTitle, pad, layout.mapTitleBaselineY);
  const routePreviewStatus = await drawRoutePreviewOnCanvas(ctx, {
    x: layout.mapOuterX,
    y: layout.mapOuterY,
    w: layout.mapOuterWidth,
    h: layout.mapOuterHeight,
    stop,
    segments: routeSegments,
    renderToken,
    showStops,
    routeStopMarkersBySegment,
  });

  if (renderToken !== signRenderToken) {
    return { basemapReady: false, basemapMode: routePreviewStatus?.basemapMode || "unknown", aborted: true };
  }

  // Footer
  ctx.fillStyle = colorCfg.footer;
  ctx.font = signCanvasFont(typeCfg.footer);
  ctx.fillText(signFooterText(), pad, layout.footerBaselineY);
  return {
    basemapReady: routePreviewStatus?.basemapReady !== false,
    basemapMode: routePreviewStatus?.basemapMode || "unknown",
  };
}

function escXml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function buildSignSvg({
  stop,
  items,
  directionFilter,
  maxRoutes,
  outputScale = 1,
  showStops = false,
}) {
  const colorCfg = SIGN_TEMPLATE.colors;
  const typeCfg = SIGN_TEMPLATE.typography;
  const legendCfg = SIGN_TEMPLATE.legend;
  const mapCfg = SIGN_TEMPLATE.map;
  const exportScale = Math.max(1, Math.min(3, Number(outputScale) || 1));
  const svgOutW = Math.round(SIGN_TEMPLATE.size.width * exportScale);
  const svgOutH = Math.round(SIGN_TEMPLATE.size.height * exportScale);
  const svgTileRetinaSuffix = "@2x";
  const W = SIGN_TEMPLATE.size.width;
  const H = SIGN_TEMPLATE.size.height;

  const routeSegments = buildRouteSegmentsForStop(stop, items, maxRoutes);
  let routeStopMarkersBySegment = null;
  try {
    routeStopMarkersBySegment = await getRouteStopMarkersBySegment(stop, routeSegments);
  } catch (err) {
    console.warn("Failed to load route stop markers for SVG export.", err);
    routeStopMarkersBySegment = null;
  }
  const {
    drawSegments,
    legendEntries,
    mergedRouteStopMarkersBySegment,
  } = buildSharedStopPatternRenderPlan(routeSegments, routeStopMarkersBySegment);
  const markersBySegment = (mergedRouteStopMarkersBySegment instanceof Map && mergedRouteStopMarkersBySegment.size > 0)
    ? mergedRouteStopMarkersBySegment
    : routeStopMarkersBySegment;
  const orderedLegendEntries = sortedLegendEntries(legendEntries);
  const legendH = signLegendHeight(orderedLegendEntries);
  const layout = getSignLayoutGeometry({ width: W, height: H, legendHeight: legendH });
  const bounds = getRouteBounds(stop, drawSegments);
  const sharedEdges = buildSharedEdges(drawSegments, stop);
  const sharedChains = buildSharedLaneChains(sharedEdges);
  const sharedLaneStateByEdgeKey = buildSharedLaneStateByEdgeKey(sharedEdges);

  const drawX = layout.mapInnerX;
  const drawY = layout.mapInnerY;
  const drawW = layout.mapInnerWidth;
  const drawH = layout.mapInnerHeight;
  const { project } = makeCanvasProjector(bounds, drawX, drawY, drawW, drawH);
  const sharedLaneByRouteId = buildSharedLanePlacementData(
    sharedChains,
    (lat, lon) => project(lat, lon),
  );
  const segPixelPointsCache = new Map();
  const transitionBySegKey = new Map();

  for (const seg of drawSegments) {
    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    let segPixelPoints = segPixelPointsCache.get(segKey);
    if (!segPixelPoints) {
      segPixelPoints = seg.points.map(([lat, lon]) => {
        const [px, py] = project(lat, lon);
        return { x: px, y: py };
      });
      segPixelPointsCache.set(segKey, segPixelPoints);
    }
    transitionBySegKey.set(
      segKey,
      buildSegmentLaneTransitions(seg, segPixelPoints, sharedLaneStateByEdgeKey),
    );
  }

  const stopLat = safeParseFloat(stop.stop_lat);
  const stopLon = safeParseFloat(stop.stop_lon);
  const stopPt = (stopLat != null && stopLon != null) ? project(stopLat, stopLon) : null;
  const subtitle = `${stop.stop_name || "—"}`;
  const code = stop.stop_code ? `#${stop.stop_code}` : `#${stop.stop_id}`;
  const qrLayout = layout.qrLayout;
  let qrDataUrl = "";
  try {
    qrDataUrl = await getStopQrCodeDataUrl(stop);
  } catch (err) {
    console.warn("Failed to generate stop QR code for SVG export.", err);
  }
  const qrCaptionSvg = SIGN_TEMPLATE.labels.qrCaptionLines.map((line, idx) => {
    const y = qrLayout.captionStartY + (idx * SIGN_TEMPLATE.header.qrCaptionLineHeight);
    return `<text x="${qrLayout.captionX.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" fill="${colorCfg.qrCaption}" ${signSvgFontAttrs(typeCfg.qrCaption)}>${escXml(line)}</text>`;
  }).join("");
  const qrImageSvg = qrDataUrl
    ? `<image href="${qrDataUrl}" x="${qrLayout.x.toFixed(2)}" y="${qrLayout.y.toFixed(2)}" width="${qrLayout.size.toFixed(2)}" height="${qrLayout.size.toFixed(2)}" />`
    : `<g><rect x="${qrLayout.x.toFixed(2)}" y="${qrLayout.y.toFixed(2)}" width="${qrLayout.size.toFixed(2)}" height="${qrLayout.size.toFixed(2)}" rx="${SIGN_TEMPLATE.header.qrFallbackRadius}" fill="${colorCfg.qrFallbackBg}" /><text x="${qrLayout.captionX.toFixed(2)}" y="${(qrLayout.y + (qrLayout.size / 2) + SIGN_TEMPLATE.header.qrFallbackLabelYOffset).toFixed(2)}" text-anchor="middle" fill="${colorCfg.qrFallbackText}" ${signSvgFontAttrs(typeCfg.qrFallback)}>${escXml(SIGN_TEMPLATE.labels.qrFallback)}</text></g>`;

  const mapClipId = "mapClip";
  const mapTileSvg = [];
  let mapReady = true;
  let basemapMode = "raster-svg-remote";
  let vectorMapHref = "";
  const vectorSnapshot = await renderVectorBasemapSnapshot({ bounds, width: drawW, height: drawH });
  if (vectorSnapshot?.canvas) {
    mapReady = vectorSnapshot.fullyLoaded !== false;
    basemapMode = "vector";
    try {
      vectorMapHref = vectorSnapshot.canvas.toDataURL("image/png");
    } catch {
      vectorMapHref = "";
    }
  }

  if (vectorMapHref) {
    mapTileSvg.push(
      `<image href="${vectorMapHref}" x="${drawX.toFixed(2)}" y="${drawY.toFixed(2)}" width="${drawW.toFixed(2)}" height="${drawH.toFixed(2)}" opacity="${SIGN_BASEMAP_OPACITY}" />`,
    );
  } else {
    basemapMode = "raster-svg-remote";
    const view = computeSignMapViewWindow(bounds, drawW, drawH, SIGN_BASEMAP_TILE_ZOOM_OFFSET);
    const {
      tileZoom,
      left,
      top,
      tileSize,
      x0,
      y0,
      x1,
      y1,
    } = view;
    for (let tx = x0; tx <= x1; tx += 1) {
      for (let ty = y0; ty <= y1; ty += 1) {
        const n = 2 ** tileZoom;
        if (ty < 0 || ty >= n) continue;
        const txx = ((tx % n) + n) % n;
        const px = drawX + ((tx * tileSize) - left);
        const py = drawY + ((ty * tileSize) - top);
        const baseHref = expandTileTemplate(MAP_TILE_BASE_URL, { z: tileZoom, x: txx, y: ty, subdomain: "a", retinaSuffix: svgTileRetinaSuffix });
        const labelsHref = expandTileTemplate(MAP_TILE_LABELS_URL, { z: tileZoom, x: txx, y: ty, subdomain: "a", retinaSuffix: svgTileRetinaSuffix });
        mapTileSvg.push(`<image href="${baseHref}" x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${tileSize.toFixed(2)}" height="${tileSize.toFixed(2)}" opacity="0.88" />`);
        mapTileSvg.push(`<image href="${labelsHref}" x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${tileSize.toFixed(2)}" height="${tileSize.toFixed(2)}" opacity="1" />`);
      }
    }
  }

  const routePathSvg = [];
  for (const seg of drawSegments) {
    const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
    const segTransition = transitionBySegKey.get(segKey);
    const metrics = segTransition?.metrics;
    const transitions = Array.isArray(segTransition?.transitions) ? segTransition.transitions : [];
    const edgeStates = Array.isArray(segTransition?.edgeStates) ? segTransition.edgeStates : [];
    if (!metrics || !Array.isArray(metrics.cumulative) || !Number.isFinite(metrics.total) || metrics.total <= 0) {
      const fallback = seg.points.map(([lat, lon], i) => {
        const [x, y] = project(lat, lon);
        return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
      }).join(" ");
      routePathSvg.push(`<path d="${fallback}" fill="none" stroke="${seg.lineColor}" stroke-width="${groupedRouteLineWidthForCount(1)}" stroke-linecap="round" stroke-linejoin="round" />`);
      continue;
    }

    const fallbackState = { offsetPx: 0, laneWidthPx: groupedRouteLineWidthForCount(1), groupCount: 1 };
    const samples = buildSegmentLaneSamples(metrics, edgeStates, transitions, { fallbackState });
    routePathSvg.push(...buildTransitionSamplesSvg(seg.lineColor, samples));
  }

  const routeStopsSvg = [];
  if (showStops && markersBySegment instanceof Map) {
    for (const seg of drawSegments) {
      const segKey = seg.overlap_route_id || `${seg.route_id}::${seg.shape_id}`;
      const stopsForSeg = markersBySegment.get(segKey) || [];
      if (!stopsForSeg.length) continue;
      for (const s of stopsForSeg) {
        const pos = markerPixelPositionOnRouteLane(
          seg,
          s,
          (lat, lon) => project(lat, lon),
          segPixelPointsCache,
          sharedLaneByRouteId,
        );
        const markerStyle = stopMarkerStyleForLineWidth(pos.laneWidthPx);
        const px = pos.x;
        const py = pos.y;
        routeStopsSvg.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="${markerStyle.radius.toFixed(2)}" fill="${seg.lineColor}" stroke="${colorCfg.stopMarkerFill}" stroke-width="${markerStyle.strokeWidth.toFixed(2)}" />`);
      }
    }
  }

  const legendSvg = [];
  const legendX = layout.mapOuterX + legendCfg.xInset;
  const lineH = legendCfg.lineHeight;
  const itemGap = legendCfg.itemGap;
  let legendY = layout.mapOuterY + layout.mapOuterHeight - legendH + legendCfg.startBaselineOffset;
  const legendMaxChars = legendCfg.maxInlineChars;
  for (const seg of orderedLegendEntries.slice(0, legendCfg.maxItems)) {
    const lines = buildLegendLinesForSegment(seg);
    const routeLabel = (seg.display_name || seg.route_short_name || "Route").toString().trim();
    const activeLabel = (seg.active_hours_text || "").toString().trim();
    const combined = activeLabel ? `${routeLabel} ${activeLabel}`.trim() : routeLabel;
    const textX = legendX + legendCfg.swatchWidth + legendCfg.textGap;
    legendSvg.push(`<rect x="${legendX.toFixed(2)}" y="${(legendY - legendCfg.swatchTopOffset).toFixed(2)}" width="${legendCfg.swatchWidth}" height="${legendCfg.swatchHeight}" rx="${legendCfg.swatchRadius}" fill="${seg.lineColor}" />`);
    if (activeLabel && combined.length <= legendMaxChars) {
      legendSvg.push(`<text x="${textX.toFixed(2)}" y="${legendY.toFixed(2)}" fill="${colorCfg.legendText}" ${signSvgFontAttrs(typeCfg.legendRegular)}><tspan font-weight="${typeCfg.legendBold.weight}">${escXml(routeLabel)}</tspan><tspan font-weight="${typeCfg.legendRegular.weight}"> ${escXml(activeLabel)}</tspan></text>`);
      legendY += lineH;
    } else {
      legendSvg.push(`<text x="${textX.toFixed(2)}" y="${legendY.toFixed(2)}" fill="${colorCfg.legendText}" ${signSvgFontAttrs(typeCfg.legendBold)}>${escXml(lines[0] || routeLabel)}</text>`);
      legendY += lineH;
      for (let i = 1; i < lines.length; i += 1) {
        legendSvg.push(`<text x="${textX.toFixed(2)}" y="${legendY.toFixed(2)}" fill="${colorCfg.legendText}" ${signSvgFontAttrs(typeCfg.legendRegular)}>${escXml(lines[i])}</text>`);
        legendY += lineH;
      }
    }
    legendY += itemGap;
    if (legendY > layout.mapOuterY + layout.mapOuterHeight - legendCfg.bottomGuard) break;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgOutW}" height="${svgOutH}" viewBox="0 0 ${W} ${H}">
  <defs>
    <clipPath id="${mapClipId}">
      <rect x="${drawX.toFixed(2)}" y="${drawY.toFixed(2)}" width="${drawW.toFixed(2)}" height="${drawH.toFixed(2)}" rx="${mapCfg.clipRadius}" />
    </clipPath>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff" />
  <text x="${layout.pad}" y="${layout.titleBaselineY}" fill="${colorCfg.title}" ${signSvgFontAttrs(typeCfg.title)}>${escXml(SIGN_TEMPLATE.labels.title)}</text>
  <text x="${layout.pad}" y="${layout.codeBaselineY}" fill="${colorCfg.code}" ${signSvgFontAttrs(typeCfg.code)}>${escXml(code)}</text>
  <rect x="${qrLayout.frameX.toFixed(2)}" y="${qrLayout.frameY.toFixed(2)}" width="${qrLayout.frameSize.toFixed(2)}" height="${qrLayout.frameSize.toFixed(2)}" rx="${SIGN_TEMPLATE.header.qrFrameRadius}" fill="${colorCfg.qrFrameFill}" stroke="${colorCfg.qrFrameStroke}" stroke-width="${SIGN_TEMPLATE.header.qrFrameStrokeWidth}" />
  ${qrImageSvg}
  ${qrCaptionSvg}
  <text x="${layout.pad}" y="${layout.subtitleBaselineY}" fill="${colorCfg.subtitle}" ${signSvgFontAttrs(typeCfg.subtitle)}>${escXml(subtitle)}</text>
  <text x="${layout.pad}" y="${layout.mapTitleBaselineY}" fill="${colorCfg.mapTitle}" ${signSvgFontAttrs(typeCfg.mapTitle)}>${escXml(SIGN_TEMPLATE.labels.mapTitle)}</text>
  <rect x="${layout.mapOuterX}" y="${layout.mapOuterY}" width="${layout.mapOuterWidth}" height="${layout.mapOuterHeight}" rx="${mapCfg.outerRadius}" fill="${mapCfg.outerFill}" stroke="${mapCfg.outerStroke}" />
  <g clip-path="url(#${mapClipId})">
    ${mapTileSvg.join("")}
  </g>
  ${routePathSvg.join("")}
  ${routeStopsSvg.join("")}
  ${stopPt ? `<circle cx="${stopPt[0].toFixed(2)}" cy="${stopPt[1].toFixed(2)}" r="${SIGN_TEMPLATE.marker.stopRadius}" fill="${colorCfg.stopMarkerFill}" stroke="${colorCfg.stopMarkerStroke}" stroke-width="${SIGN_TEMPLATE.marker.stopStrokeWidth}" />` : ""}
  ${legendSvg.join("")}
  <text x="${layout.pad}" y="${layout.footerBaselineY}" fill="${colorCfg.footer}" ${signSvgFontAttrs(typeCfg.footer)}>${escXml(signFooterText())}</text>
</svg>`;
  return {
    svg,
    mapReady,
    basemapMode,
  };
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

function rerenderSelectedStopSign() {
  const stop = selectedStop;
  if (!stop) return;
  const directionFilter = FIXED_DIRECTION_FILTER;
  const items = selectedStopRouteSummary || getRouteSummaryForStop(stop, directionFilter);
  selectedStopRouteSummary = items;
  const maxRoutes = items.length;
  const renderToken = ++signRenderToken;
  drawSign({
    stop,
    items,
    directionFilter,
    maxRoutes,
    renderToken,
    outputScale: FIXED_EXPORT_SCALE,
    showStops: showStopsOnSign,
  }).catch((err) => console.error("Sign render failed", err));
}

function syncShowStopsToggleUi() {
  const isOn = !!showStopsOnSign;
  if (ui.showStopsToggle) ui.showStopsToggle.checked = isOn;
  if (ui.showStopsToggleLabel) {
    ui.showStopsToggleLabel.textContent = isOn ? "Hide Stops" : "Show Stops";
  }
}

function isEditableElementTarget(target) {
  const elTarget = target instanceof Element ? target : null;
  if (!elTarget) return false;
  if (elTarget.closest("input, textarea, select")) return true;
  return !!elTarget.closest("[contenteditable='true']");
}

function toggleQrUrlMode() {
  if (exportJobInProgress) return;
  useCenteredQrMapUrl = !useCenteredQrMapUrl;
  console.log(`QR URL mode: ${useCenteredQrMapUrl ? "Centered" : "Plain api=1"} (Ctrl+Shift+Y to toggle)`);
  rerenderSelectedStopSign();
}

function onQrUrlModeHotkey(ev) {
  if (!ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return;
  if (ev.code !== QR_URL_MODE_TOGGLE_KEY) return;
  if (isEditableElementTarget(ev.target)) return;
  ev.preventDefault();
  toggleQrUrlMode();
}

function onGlobalKeyDown(ev) {
  if (ev.code === "Escape" && activeMassDownloadCancelToken) {
    if (!isEditableElementTarget(ev.target)) {
      ev.preventDefault();
      requestMassDownloadCancel();
    }
    return;
  }
  if (ev.code === "Escape" && massSelectionMode) {
    if (!isEditableElementTarget(ev.target)) {
      ev.preventDefault();
      setMassSelectionMode(false);
      setMassDownloadStatus("Selection canceled.");
    }
    return;
  }
  onQrUrlModeHotkey(ev);
}

function openStop(stop) {
  if (exportJobInProgress || massSelectionMode) return;
  selectedStop = stop;
  resetPreviewZoom();
  syncShowStopsToggleUi();

  ui.modalTitle.textContent = stop.stop_name || "Bus Stop";
  ui.modalSubtitle.textContent = stop.stop_code ? `Stop #${stop.stop_code}` : `Stop ID: ${stop.stop_id}`;

  const directionFilter = FIXED_DIRECTION_FILTER;

  openModal();
  selectedStopRouteSummary = getRouteSummaryForStop(stop, directionFilter);
  const maxRoutes = selectedStopRouteSummary.length;
  const debugSegments = buildRouteSegmentsForStop(stop, selectedStopRouteSummary, maxRoutes);
  const overlapEvents = [];
  const overlapOrder = [];
  buildSharedEdges(debugSegments, stop, { traceOut: overlapEvents, traceOrderOut: overlapOrder });

  const legendH = signLegendHeight(debugSegments);
  const signLayout = getSignLayoutGeometry({
    width: SIGN_TEMPLATE.size.width,
    height: SIGN_TEMPLATE.size.height,
    legendHeight: legendH,
  });
  const drawW = signLayout.mapInnerWidth;
  const drawH = signLayout.mapInnerHeight;
  const bounds = getRouteBounds(stop, debugSegments);
  const signMapView = computeSignMapViewWindow(bounds, drawW, drawH, 0);
  const rasterFallbackView = computeSignMapViewWindow(bounds, drawW, drawH, SIGN_BASEMAP_TILE_ZOOM_OFFSET);
  console.log("Shared route ordering events", {
    stop_id: stop.stop_id,
    stop_code: stop.stop_code || null,
    stop_name: stop.stop_name || "",
    direction_filter: directionFilter,
    max_routes: maxRoutes,
    events: overlapEvents,
    order: overlapOrder,
  });
  console.log("Sign map render details", {
    stop_id: stop.stop_id,
    stop_code: stop.stop_code || null,
    stop_name: stop.stop_name || "",
    route_count: debugSegments.length,
    bounds,
    draw_area: {
      width: drawW,
      height: drawH,
      legend_height: legendH,
      map_outer_width: signLayout.mapOuterWidth,
      map_outer_height: signLayout.mapOuterHeight,
    },
    zoom: {
      projection_render_zoom: signMapView.renderZoom,
      basemap_base_tile_zoom: signMapView.baseTileZoom,
      basemap_tile_zoom_offset: 0,
      basemap_tile_zoom_used: signMapView.tileZoom,
      basemap_scale: signMapView.scale,
    },
    basemap_renderer: {
      preferred: "vector-maplibre",
      vector_style_url: SIGN_VECTOR_STYLE_URL,
      vector_road_label_size_scale: SIGN_VECTOR_ROAD_LABEL_SIZE_SCALE,
      vector_road_label_density_scale: SIGN_VECTOR_ROAD_LABEL_DENSITY_SCALE,
      vector_road_label_minzoom_shift: SIGN_VECTOR_ROAD_LABEL_MINZOOM_SHIFT,
      vector_road_label_reference_zoom: SIGN_VECTOR_ROAD_LABEL_REFERENCE_ZOOM,
      vector_road_label_zoom_compensation: SIGN_VECTOR_ROAD_LABEL_ZOOM_COMPENSATION,
      vector_road_label_zoom_factor: roadLabelZoomCompensationFactor(signMapView.renderZoom),
      vector_road_label_color: SIGN_VECTOR_ROAD_LABEL_COLOR,
      vector_gl_zoom_offset: SIGN_VECTOR_GL_ZOOM_OFFSET,
      vector_basemap_opacity: SIGN_BASEMAP_OPACITY,
      fallback: "raster-tiles",
      fallback_tile_zoom_offset: SIGN_BASEMAP_TILE_ZOOM_OFFSET,
      fallback_tile_zoom_used: rasterFallbackView.tileZoom,
    },
    tile_window: {
      x0: signMapView.x0,
      y0: signMapView.y0,
      x1: signMapView.x1,
      y1: signMapView.y1,
      tile_size_px: signMapView.tileSize,
      left: signMapView.left,
      top: signMapView.top,
      right: signMapView.right,
      bottom: signMapView.bottom,
    },
    center: {
      lat: signMapView.centerLat,
      lon: signMapView.centerLon,
    },
    show_stops: showStopsOnSign,
  });

  rerenderSelectedStopSign();
}

function stopExportContext(stop) {
  const directionFilter = FIXED_DIRECTION_FILTER;
  const items = getRouteSummaryForStop(stop, directionFilter);
  return {
    directionFilter,
    items,
    maxRoutes: Math.max(0, items.length),
    outputScale: FIXED_EXPORT_SCALE,
    showStops: showStopsOnSign,
  };
}

async function renderStablePngToCanvas(stop, context = null, cancelToken = null) {
  const exportContext = context || stopExportContext(stop);
  const cancelMessage = `Mass download canceled while rendering PNG for ${stopDisplayLabel(stop)}.`;
  let lastBasemapMode = "unknown";

  for (let attempt = 1; attempt <= EXPORT_MAX_RENDER_ATTEMPTS; attempt += 1) {
    throwIfCanceled(cancelToken, cancelMessage);
    const renderToken = ++signRenderToken;
    const drawStatus = await drawSign({
      stop,
      items: exportContext.items,
      directionFilter: exportContext.directionFilter,
      maxRoutes: exportContext.maxRoutes,
      renderToken,
      outputScale: exportContext.outputScale,
      showStops: exportContext.showStops,
    });
    throwIfCanceled(cancelToken, cancelMessage);
    if (renderToken !== signRenderToken) {
      throw new Error(`Render for ${stopDisplayLabel(stop)} was superseded.`);
    }

    const basemapMode = drawStatus?.basemapMode || "unknown";
    const basemapReady = drawStatus?.basemapReady !== false;
    if (basemapReady) {
      return { attempts: attempt, basemapMode };
    }

    lastBasemapMode = basemapMode;
    if (attempt < EXPORT_MAX_RENDER_ATTEMPTS) {
      await waitMsCancellable(exportRetryDelayMs(attempt), cancelToken, cancelMessage);
    }
  }

  throw new Error(
    `PNG basemap for ${stopDisplayLabel(stop)} was not fully ready after ${EXPORT_MAX_RENDER_ATTEMPTS} attempts (mode: ${lastBasemapMode}).`,
  );
}

async function renderStablePngBlob(stop, context = null, cancelToken = null) {
  const stable = await renderStablePngToCanvas(stop, context, cancelToken);
  const blob = await canvasToBlob(ui.signCanvas, "image/png");
  return {
    ...stable,
    blob,
  };
}

async function renderStableSvgMarkup(stop, context = null, cancelToken = null) {
  const exportContext = context || stopExportContext(stop);
  const cancelMessage = `Mass download canceled while rendering SVG for ${stopDisplayLabel(stop)}.`;
  let lastBasemapMode = "unknown";

  for (let attempt = 1; attempt <= EXPORT_MAX_RENDER_ATTEMPTS; attempt += 1) {
    throwIfCanceled(cancelToken, cancelMessage);
    const svgResult = await buildSignSvg({
      stop,
      items: exportContext.items,
      directionFilter: exportContext.directionFilter,
      maxRoutes: exportContext.maxRoutes,
      outputScale: exportContext.outputScale,
      showStops: exportContext.showStops,
    });
    throwIfCanceled(cancelToken, cancelMessage);
    const currentSvg = typeof svgResult === "string" ? svgResult : String(svgResult?.svg || "");
    if (!currentSvg) {
      throw new Error(`Failed to build SVG for ${stopDisplayLabel(stop)}.`);
    }

    const basemapMode = typeof svgResult === "string"
      ? "raster-svg-remote"
      : (svgResult?.basemapMode || "unknown");
    const basemapReady = typeof svgResult === "string"
      ? true
      : (svgResult?.mapReady !== false);

    if (basemapReady) {
      return { svg: currentSvg, attempts: attempt, basemapMode };
    }

    lastBasemapMode = basemapMode;
    if (attempt < EXPORT_MAX_RENDER_ATTEMPTS) {
      await waitMsCancellable(exportRetryDelayMs(attempt), cancelToken, cancelMessage);
    }
  }

  throw new Error(
    `SVG basemap for ${stopDisplayLabel(stop)} was not fully ready after ${EXPORT_MAX_RENDER_ATTEMPTS} attempts (mode: ${lastBasemapMode}).`,
  );
}

async function downloadSelectedStopAsPng() {
  const stop = selectedStop;
  if (!stop || exportJobInProgress) return;

  setExportJobInProgress(true);
  try {
    setProgress(4, `Rendering PNG for ${stopDisplayLabel(stop)}…`);
    const context = stopExportContext(stop);
    const { blob } = await renderStablePngBlob(stop, context);
    triggerBlobDownload(buildStopExportFilename(stop, "png"), blob);
    setProgress(100, "Ready. Click a stop.");
  } finally {
    setExportJobInProgress(false);
  }
}

async function downloadSelectedStopAsSvg() {
  const stop = selectedStop;
  if (!stop || exportJobInProgress) return;

  setExportJobInProgress(true);
  try {
    setProgress(4, `Rendering SVG for ${stopDisplayLabel(stop)}…`);
    const context = stopExportContext(stop);
    const { svg } = await renderStableSvgMarkup(stop, context);
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    triggerBlobDownload(buildStopExportFilename(stop, "svg"), blob);
    setProgress(100, "Ready. Click a stop.");
  } finally {
    setExportJobInProgress(false);
  }
}

async function buildMassDownloadZip(stopsToExport, format, cancelToken = null) {
  const targetFormat = format === "svg" ? "svg" : "png";
  const total = stopsToExport.length;
  const zip = new JSZip();
  const usedNames = new Set();
  const cancelMessage = "Mass download canceled during ZIP generation.";

  throwIfCanceled(cancelToken, cancelMessage);

  for (let i = 0; i < total; i += 1) {
    throwIfCanceled(cancelToken, cancelMessage);
    const stop = stopsToExport[i];
    const renderPct = 5 + ((i / total) * 85);
    setProgress(renderPct, `Rendering ${targetFormat.toUpperCase()} ${i + 1}/${total}: ${stopDisplayLabel(stop)}…`);
    const context = stopExportContext(stop);
    const filename = uniqueFilename(buildStopExportFilename(stop, targetFormat), usedNames);

    if (targetFormat === "png") {
      const { blob } = await renderStablePngBlob(stop, context, cancelToken);
      zip.file(filename, blob);
    } else {
      const { svg } = await renderStableSvgMarkup(stop, context, cancelToken);
      zip.file(filename, svg);
    }
  }

  throwIfCanceled(cancelToken, cancelMessage);
  setProgress(92, `Creating ${targetFormat.toUpperCase()} ZIP…`);
  const zipGenerateOptions = targetFormat === "png"
    ? {
      type: "blob",
      compression: "STORE",
    }
    : {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 4 },
    };
  const zipBlob = await zip.generateAsync(
    zipGenerateOptions,
    (meta) => {
      throwIfCanceled(cancelToken, cancelMessage);
      const p = Math.max(0, Math.min(100, Number(meta?.percent) || 0));
      const pct = 92 + (p * 0.08);
      setProgress(pct, `Creating ${targetFormat.toUpperCase()} ZIP… ${Math.round(p)}%`);
    },
  );

  throwIfCanceled(cancelToken, cancelMessage);
  return zipBlob;
}

async function downloadSelectedRegionZip() {
  if (exportJobInProgress) return;
  if (!massSelectedStops.length) {
    alert("Select a region first.");
    return;
  }

  const format = ui.massDownloadFormat?.value === "svg" ? "svg" : "png";
  const confirmed = window.confirm(`Download ${niceInt(massSelectedStops.length)} stops as ${format.toUpperCase()} in one ZIP?`);
  if (!confirmed) return;

  const stopsToExport = massSelectedStops.slice();
  const restoreStop = selectedStop;
  const restoreSummary = selectedStopRouteSummary;
  const cancelToken = { canceled: false, reason: "", cancelError: null };

  setMassSelectionMode(false);
  activeMassDownloadCancelToken = cancelToken;
  setExportJobInProgress(true);
  try {
    setMassDownloadStatus(`Preparing ${niceInt(stopsToExport.length)} ${format.toUpperCase()} file${stopsToExport.length === 1 ? "" : "s"}…`);
    const zipBlob = await buildMassDownloadZip(stopsToExport, format, cancelToken);
    const zipName = buildMassZipFilename(format, stopsToExport.length);
    triggerBlobDownload(zipName, zipBlob);
    setMassDownloadStatus(`Downloaded ${zipName}`);
    setProgress(100, "Ready. Click a stop.");
  } catch (err) {
    if (isCanceledError(err)) {
      setMassDownloadStatus("Mass download canceled.");
      setProgress(100, "Ready. Click a stop.");
      return;
    }
    throw err;
  } finally {
    if (activeMassDownloadCancelToken === cancelToken) {
      activeMassDownloadCancelToken = null;
    }
    if (restoreStop) {
      selectedStop = restoreStop;
      selectedStopRouteSummary = restoreSummary;
      rerenderSelectedStopSign();
    }
    setExportJobInProgress(false);
  }
}

ui.downloadBtn.addEventListener("click", async () => {
  try {
    await downloadSelectedStopAsPng();
  } catch (err) {
    console.error(err);
    setProgress(100, "Ready. Click a stop.");
    alert("Failed to export PNG. Try again in a moment.");
  }
});

ui.downloadSvgBtn.addEventListener("click", async () => {
  try {
    await downloadSelectedStopAsSvg();
  } catch (err) {
    console.error(err);
    setProgress(100, "Ready. Click a stop.");
    alert("Failed to export SVG. Try again in a moment.");
  }
});

ui.massSelectRegionBtn?.addEventListener("click", () => {
  if (exportJobInProgress) return;
  if (!map || !stops.length) {
    alert("Load GTFS data before using Mass Download.");
    return;
  }
  if (massSelectionMode) {
    setMassSelectionMode(false);
    setMassDownloadStatus("Selection canceled.");
    return;
  }
  setMassSelectionMode(true);
});

ui.massDownloadBtn?.addEventListener("click", async () => {
  try {
    await downloadSelectedRegionZip();
  } catch (err) {
    if (isCanceledError(err)) return;
    console.error(err);
    setProgress(100, "Ready. Click a stop.");
    setMassDownloadStatus(`Mass download failed: ${err?.message || err}`);
    alert("Mass download failed. Try again in a moment.");
  }
});

ui.massCancelBtn?.addEventListener("click", () => {
  requestMassDownloadCancel();
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

ui.showStopsToggle?.addEventListener("change", () => {
  if (exportJobInProgress) {
    syncShowStopsToggleUi();
    return;
  }
  showStopsOnSign = !!ui.showStopsToggle?.checked;
  syncShowStopsToggleUi();
  if (showStopsOnSign) {
    void prewarmStopOverlayData(bootGeneration);
  }
  rerenderSelectedStopSign();
});

ui.reloadBtn.addEventListener("click", async () => {
  if (!usingPreloadedSummaries) return;
  const feedDateIso = dateKeyToIsoDate(feedUpdatedDateKey);
  const linkDateKey = parseDateKeyFromHistoryGtfsUrl(TRANSLINK_LATEST_GTFS_URL);
  const linkDateIso = dateKeyToIsoDate(linkDateKey);
  console.log("GTFS update date check", {
    feed_date_key: feedUpdatedDateKey,
    feed_date_iso: feedDateIso || null,
    download_url: TRANSLINK_LATEST_GTFS_URL,
    download_date_key: linkDateKey,
    download_date_iso: linkDateIso || null,
    dates_match: Number.isFinite(feedUpdatedDateKey) && Number.isFinite(linkDateKey) && feedUpdatedDateKey === linkDateKey,
  });

  setUpdatesUi({
    showButton: false,
    showStatus: true,
    statusText: "GTFS Downloaded (upload to apply)",
    buttonText: "Download Updated GTFS File",
    disableButton: false,
  });
  window.open(TRANSLINK_LATEST_GTFS_URL, "_blank", "noopener,noreferrer");
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
  activeZip = null;
  stops = [];
  stopsById = new Map();
  routesById = new Map();
  tripsById = new Map();
  stopToTrips = new Map();
  stopTripTimes = new Map();
  shapesById = new Map();
  serviceActiveWeekdaysById = new Map();
  hasServiceCalendarData = false;
  useTransLinkStopScheduleUrl = false;
  feedUpdatedDateLabel = "";
  feedUpdatedDateKey = null;
  signVectorUnavailable = false;
  usingPreloadedSummaries = false;
  selectedStop = null;
  selectedStopRouteSummary = null;
  routeSummaryCache = new Map();
  preloadedStopOverlayByStop = new Map();
  resetTripStopOverlayCaches();
  setMassSelectionMode(false);
  clearMassSelection();
  setMassDownloadStatus("Click “Select Region”, then drag over the map.");
  setUpdatesUi({ showButton: false, showStatus: false });

  try {
    const zip = zipFile ? await loadZipFromFile(zipFile) : await loadZipFromUrl(zipUrl);
    activeZip = zip;
    const canUsePreloadedSummaries = !zipFile && zipName === "google_transit.zip";
    const preloadPromise = canUsePreloadedSummaries ? tryLoadPreloadedRouteSummaries() : Promise.resolve(false);

    // 1) stops.txt (small-ish)
    setProgress(10, "Parsing stops.txt…");
    stops = await parseCSVFromZip(zip, "stops.txt");
    stopsById = new Map();
    for (const s of stops) {
      if (!s?.stop_id) continue;
      stopsById.set(String(s.stop_id), s);
    }
    ui.stopsCount.textContent = niceInt(stops.length);
    if (generationAtStart !== bootGeneration) return;

    if (zip.file("feed_info.txt")) {
      try {
        const feedInfoRows = await parseCSVFromZip(zip, "feed_info.txt");
        feedUpdatedDateLabel = deriveFeedUpdatedDateLabel(feedInfoRows);
        feedUpdatedDateKey = deriveFeedUpdatedDateKey(feedInfoRows);
      } catch (err) {
        console.warn("Failed to parse feed_info.txt for update date.", err);
      }
    }
    if (generationAtStart !== bootGeneration) return;

    // Only the built-in preloaded GTFS should use TransLink stop schedule links.
    // User-uploaded feeds always use Google Maps URLs.
    useTransLinkStopScheduleUrl = !zipFile && zipName === "google_transit.zip";
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
      usingPreloadedSummaries = true;
      setProgress(45, "Finishing shapes…");
      await shapesPromise;
      if (generationAtStart !== bootGeneration) return;
      ui.routesCount.textContent = "Preloaded";
      ui.tripsCount.textContent = "Preloaded";
      ui.indexCount.textContent = "Preloaded";
      setProgress(98, "Rendering stops on map…");
      addStopsToMap();
      setProgress(100, "Ready. Click a stop.");
      if (isCurrentFeedUpToDateWithDownloadLink()) {
        setUpdatesUi({ showButton: false, showStatus: true, statusText: "GTFS Uploaded" });
      } else {
        setUpdatesUi({ showButton: true, showStatus: false, buttonText: "Download Updated GTFS File", disableButton: false });
      }
      setTimeout(() => {
        void prewarmStopOverlayData(generationAtStart);
      }, 0);
      console.log("Loaded with precomputed route summaries.");
      return;
    }

    // 4) routes + trips + calendar + stop_times buffer (parallelized for faster uploads)
    setProgress(40, "Parsing routes/trips/calendar…");
    const stopTimesFile = zip.file("stop_times.txt");
    if (!stopTimesFile) throw new Error("Missing stop_times.txt in GTFS zip");

    const routesPromise = parseCSVFromZip(zip, "routes.txt");
    const tripsPromise = parseCSVFromZip(zip, "trips.txt");
    const calendarPromise = zip.file("calendar.txt") ? parseCSVFromZip(zip, "calendar.txt") : Promise.resolve([]);
    const calendarDatesPromise = zip.file("calendar_dates.txt") ? parseCSVFromZip(zip, "calendar_dates.txt") : Promise.resolve([]);
    const stopTimesBufferPromise = stopTimesFile.async("arraybuffer");

    const [routes, trips, calendarRows, calendarDateRows, stopTimesBuffer] = await Promise.all([
      routesPromise,
      tripsPromise,
      calendarPromise,
      calendarDatesPromise,
      stopTimesBufferPromise,
    ]);
    if (generationAtStart !== bootGeneration) return;

    for (const r of routes) routesById.set(r.route_id, r);
    ui.routesCount.textContent = niceInt(routesById.size);

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

    hasServiceCalendarData = calendarRows.length > 0 || calendarDateRows.length > 0;
    if (hasServiceCalendarData) {
      serviceActiveWeekdaysById = buildServiceActiveWeekdays(calendarRows, calendarDateRows);
    }
    if (generationAtStart !== bootGeneration) return;

    // 5) stop_times worker path first (multithreaded)
    setProgress(55, "Indexing stop_times.txt…");

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
    setUpdatesUi({ showButton: false, showStatus: true, statusText: "GTFS Uploaded" });
    setTimeout(() => {
      void prewarmStopOverlayData(generationAtStart);
    }, 0);
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
  syncShowStopsToggleUi();
  initMap();
  await boot({ zipUrl: DEFAULT_ZIP_URL, zipName: "google_transit.zip" });
});
