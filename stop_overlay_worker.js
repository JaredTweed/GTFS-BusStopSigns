/* eslint-disable no-restricted-globals */
/* eslint-disable no-console */

let papaReady = false;
let indexReady = false;
let tripStopsByTripId = new Map(); // trip_id -> [stop_id...]

function ensurePapa() {
  if (papaReady) return;
  importScripts("https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js");
  papaReady = true;
}

function buildTripStopIndex(stopTimesText) {
  ensurePapa();

  const rowsByTrip = new Map(); // trip_id -> [[seq, stop_id], ...]

  return new Promise((resolve, reject) => {
    let rowCount = 0;
    Papa.parse(stopTimesText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      step: (results) => {
        rowCount += 1;
        const row = results.data || {};
        const tripId = row.trip_id;
        const stopId = row.stop_id;
        if (!tripId || !stopId) return;

        let rows = rowsByTrip.get(tripId);
        if (!rows) {
          rows = [];
          rowsByTrip.set(tripId, rows);
        }

        const seq = Number.parseInt(row.stop_sequence, 10);
        rows.push([
          Number.isFinite(seq) ? seq : rows.length,
          String(stopId),
        ]);

        if (rowCount % 200000 === 0) {
          postMessage({ type: "progress", phase: "build_index", rowCount });
        }
      },
      complete: () => {
        const out = new Map();
        for (const [tripId, rows] of rowsByTrip.entries()) {
          rows.sort((a, b) => a[0] - b[0]);
          const seqStops = [];
          let lastKey = "";
          for (const [seq, stopId] of rows) {
            const key = `${seq}::${stopId}`;
            if (key === lastKey) continue;
            lastKey = key;
            seqStops.push(stopId);
          }
          out.set(tripId, seqStops);
        }
        resolve({ tripStopsByTripId: out, rowCount });
      },
      error: (err) => reject(err),
    });
  });
}

function selectTripStops(tripIds) {
  const out = {};
  for (const tripIdRaw of tripIds || []) {
    const tripId = String(tripIdRaw || "");
    if (!tripId) continue;
    const seq = tripStopsByTripId.get(tripId);
    if (!Array.isArray(seq)) continue;
    out[tripId] = seq;
  }
  return out;
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const requestId = Number(msg.requestId);

  try {
    if (msg.type === "build_index") {
      if (indexReady) {
        postMessage({
          type: "build_complete",
          requestId,
          tripCount: tripStopsByTripId.size,
          cached: true,
        });
        return;
      }

      if (!msg.stopTimesBuffer) throw new Error("Missing stop_times buffer");
      const stopTimesText = new TextDecoder("utf-8").decode(msg.stopTimesBuffer);
      const built = await buildTripStopIndex(stopTimesText);
      tripStopsByTripId = built.tripStopsByTripId;
      indexReady = true;

      postMessage({
        type: "build_complete",
        requestId,
        tripCount: tripStopsByTripId.size,
        rowCount: built.rowCount,
      });
      return;
    }

    if (msg.type === "get_trip_stops") {
      const tripIds = Array.isArray(msg.tripIds) ? msg.tripIds : [];
      const selected = selectTripStops(tripIds);
      postMessage({
        type: "trip_stops",
        requestId,
        tripStopsByTripId: selected,
        indexReady,
      });
      return;
    }

    if (msg.type === "reset") {
      tripStopsByTripId = new Map();
      indexReady = false;
      postMessage({ type: "reset_complete", requestId });
      return;
    }

    throw new Error(`Unknown message type: ${String(msg.type || "")}`);
  } catch (err) {
    postMessage({
      type: "error",
      requestId,
      error: err?.message || String(err),
    });
  }
};
