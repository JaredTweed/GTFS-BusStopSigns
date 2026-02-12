/* eslint-disable no-restricted-globals */
/* eslint-disable no-console */

let papaReady = false;

function ensurePapa() {
  if (papaReady) return;
  importScripts("https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js");
  papaReady = true;
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

function normalizeColor(hex, fallback = "#3b82f6") {
  if (!hex) return fallback;
  const v = String(hex).trim().replace("#", "");
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v}`;
  if (/^[0-9a-fA-F]{3}$/.test(v)) return `#${v}`;
  return fallback;
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

function buildSummaryItemsFromAgg(aggMap, routesById) {
  const items = Array.from(aggMap.values()).map((x) => {
    const r = routesById[x.route_id];
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

function computeStopSummaries({ stopTripTimesById, tripsById, routesById, hasServiceCalendarData, serviceActiveDatesLastWeekById, lastWeekWeekdayByDateKey }) {
  const outStops = {};

  for (const [stopId, byTrip] of stopTripTimesById.entries()) {
    const aggAll = new Map();

    for (const [tripId, depSec] of byTrip.entries()) {
      const t = tripsById[tripId];
      if (!t) continue;
      const serviceDates = serviceActiveDatesLastWeekById[t.service_id];
      if (hasServiceCalendarData && (!serviceDates || serviceDates.length === 0)) continue;

      const dir = (t.direction_id === "" || t.direction_id == null) ? null : String(t.direction_id);
      const route = routesById[t.route_id];
      if (!route) continue;

      const headsign = (t.trip_headsign && String(t.trip_headsign).trim()) || (route.route_long_name || route.route_short_name || "");
      const key = `${t.route_id}||${dir ?? ""}`;
      const cur = aggAll.get(key) || {
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
      if (depSec != null) {
        if (serviceDates && serviceDates.length > 0) {
          for (const dateKeyRaw of serviceDates) {
            const dateKey = Number(dateKeyRaw);
            const weekday = lastWeekWeekdayByDateKey[String(dateKey)] ?? lastWeekWeekdayByDateKey[dateKey];
            if (weekday == null) continue;
            cur.times.push(depSec);
            const groupKey = dayGroupKeyFromWeekday(Number(weekday));
            cur.timesByGroup[groupKey].push(depSec);
          }
        } else {
          cur.times.push(depSec);
        }
      }
      aggAll.set(key, cur);
    }

    const agg0 = new Map(Array.from(aggAll.entries()).filter(([, v]) => String(v.direction_id) === "0"));
    const agg1 = new Map(Array.from(aggAll.entries()).filter(([, v]) => String(v.direction_id) === "1"));
    outStops[stopId] = {
      all: buildSummaryItemsFromAgg(aggAll, routesById),
      0: buildSummaryItemsFromAgg(agg0, routesById),
      1: buildSummaryItemsFromAgg(agg1, routesById),
    };
  }

  return outStops;
}

function parseStopTimesToTripTimes(stopTimesText) {
  ensurePapa();
  const stopTripTimesById = new Map();

  return new Promise((resolve, reject) => {
    let rowCount = 0;
    Papa.parse(stopTimesText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      step: (results) => {
        rowCount += 1;
        const row = results.data || {};
        const stopId = row.stop_id;
        const tripId = row.trip_id;
        if (!stopId || !tripId) return;

        const depSec = parseGtfsTimeToSeconds(row.departure_time) ?? parseGtfsTimeToSeconds(row.arrival_time);
        let byTrip = stopTripTimesById.get(stopId);
        if (!byTrip) {
          byTrip = new Map();
          stopTripTimesById.set(stopId, byTrip);
        }
        if (!byTrip.has(tripId)) {
          byTrip.set(tripId, depSec);
        } else {
          const prev = byTrip.get(tripId);
          if (depSec != null && (prev == null || depSec < prev)) byTrip.set(tripId, depSec);
        }

        if (rowCount % 50000 === 0) postMessage({ type: "progress", rowCount });
      },
      complete: () => resolve({ stopTripTimesById, rowCount }),
      error: (err) => reject(err),
    });
  });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== "build") return;

  try {
    const {
      stopTimesBuffer,
      tripsById,
      routesById,
      hasServiceCalendarData,
      serviceActiveDatesLastWeekById,
      lastWeekWeekdayByDateKey,
    } = msg;

    const stopTimesText = new TextDecoder("utf-8").decode(stopTimesBuffer);
    const { stopTripTimesById, rowCount } = await parseStopTimesToTripTimes(stopTimesText);
    const stops = computeStopSummaries({
      stopTripTimesById,
      tripsById: tripsById || {},
      routesById: routesById || {},
      hasServiceCalendarData: !!hasServiceCalendarData,
      serviceActiveDatesLastWeekById: serviceActiveDatesLastWeekById || {},
      lastWeekWeekdayByDateKey: lastWeekWeekdayByDateKey || {},
    });

    postMessage({
      type: "result",
      data: { version: 1, stops },
      stopCount: stopTripTimesById.size,
      rowCount,
    });
  } catch (err) {
    postMessage({ type: "error", error: err?.message || String(err) });
  }
};
