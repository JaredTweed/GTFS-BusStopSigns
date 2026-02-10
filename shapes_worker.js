/* eslint-disable no-restricted-globals */

let papaReady = false;

function ensurePapa() {
  if (papaReady) return;
  importScripts("https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js");
  papaReady = true;
}

function safeParseFloat(x) {
  const v = Number.parseFloat(x);
  return Number.isFinite(v) ? v : null;
}

function parseShapesCsv(shapesText) {
  ensurePapa();
  const rawShapesById = new Map();

  return new Promise((resolve, reject) => {
    Papa.parse(shapesText, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      step: (results) => {
        const row = results.data || {};
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
      complete: () => {
        const out = {};
        for (const [shapeId, pts] of rawShapesById.entries()) {
          pts.sort((a, b) => a.seq - b.seq);
          out[shapeId] = pts.map((p) => [p.lat, p.lon]);
        }
        resolve(out);
      },
      error: (err) => reject(err),
    });
  });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== "build") return;

  try {
    const shapesBuffer = msg.shapesBuffer;
    const shapesText = new TextDecoder("utf-8").decode(shapesBuffer);
    const shapes = await parseShapesCsv(shapesText);
    postMessage({ type: "result", shapes });
  } catch (err) {
    postMessage({ type: "error", error: err?.message || String(err) });
  }
};
