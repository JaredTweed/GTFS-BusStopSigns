#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLES_DIR="${EXAMPLES_DIR:-${ROOT_DIR}/examples}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4173}"
SETTLE_MS="${SETTLE_MS:-300}"
MAX_RENDER_ATTEMPTS="${MAX_RENDER_ATTEMPTS:-8}"
STABILIZE_PAUSE_MS="${STABILIZE_PAUSE_MS:-700}"
BASE_URL_INPUT="${BASE_URL:-}"
SIGN_FOOTER_URL="${SIGN_FOOTER_URL:-https://jaredtweed.github.io/BusStopSigns/}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command not found: ${cmd}" >&2
    exit 1
  fi
}

normalize_code() {
  local raw="$1"
  local code="${raw##*/}"
  code="${code#\#}"
  code="${code%.png}"
  printf '%s\n' "$code"
}

print_usage() {
  cat <<'USAGE'
Usage:
  ./update_example_pngs.sh                # refresh all existing examples/#*.png
  ./update_example_pngs.sh 62012 54997    # refresh specific stop codes/ids

Optional env vars:
  BASE_URL   Use an already-running app URL (skips local python server)
  SIGN_FOOTER_URL  Footer contribution URL for generated examples (default: https://jaredtweed.github.io/BusStopSigns/)
  HOST       Local server host (default: 127.0.0.1)
  PORT       Local server port (default: 4173)
  EXAMPLES_DIR  Output folder (default: ./examples)
  SETTLE_MS  Extra wait after each render attempt before capture (default: 300)
  MAX_RENDER_ATTEMPTS  Max full re-renders per stop while waiting for stable output (default: 8)
  STABILIZE_PAUSE_MS  Pause between re-renders while map tiles settle (default: 700)
USAGE
}

wait_for_url() {
  local url="$1"
  python3 - "$url" <<'PY'
import sys
import time
import urllib.request

url = sys.argv[1]
last_err = None
for _ in range(120):
    try:
        with urllib.request.urlopen(url, timeout=2) as res:
            if 200 <= getattr(res, "status", 200) < 500:
                sys.exit(0)
    except Exception as exc:  # pragma: no cover
        last_err = exc
    time.sleep(0.25)

print(f"Error: timed out waiting for {url}: {last_err}", file=sys.stderr)
sys.exit(1)
PY
}

require_cmd node
require_cmd python3

if (($# > 0)) && [[ "${1}" == "-h" || "${1}" == "--help" ]]; then
  print_usage
  exit 0
fi

if ! node -e "require('playwright')" >/dev/null 2>&1; then
  cat >&2 <<'MSG'
Error: playwright is not installed in this repository.
Install it once with:
  npm install --no-save playwright
  npx playwright install chromium
MSG
  exit 1
fi

mkdir -p "$EXAMPLES_DIR"

declare -a STOP_CODES=()
if (($# > 0)); then
  for raw in "$@"; do
    code="$(normalize_code "$raw")"
    if [[ -n "$code" ]]; then
      STOP_CODES+=("$code")
    fi
  done
else
  mapfile -t existing_pngs < <(find "$EXAMPLES_DIR" -maxdepth 1 -type f -name '#*.png' | sort)
  for png in "${existing_pngs[@]}"; do
    code="$(normalize_code "$png")"
    if [[ -n "$code" ]]; then
      STOP_CODES+=("$code")
    fi
  done
fi

if ((${#STOP_CODES[@]} == 0)); then
  echo "Error: no example PNG targets found. Add files like ${EXAMPLES_DIR}/#62012.png or pass stop codes as args." >&2
  exit 1
fi

TARGET_URL="$BASE_URL_INPUT"
SERVER_PID=""
SERVER_LOG=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$SERVER_LOG" ]]; then
    rm -f "$SERVER_LOG"
  fi
}
trap cleanup EXIT

if [[ -z "$TARGET_URL" ]]; then
  TARGET_URL="http://${HOST}:${PORT}/index.html"
  SERVER_LOG="$(mktemp "${TMPDIR:-/tmp}/example-png-server.XXXXXX.log")"
  python3 -m http.server "$PORT" --bind "$HOST" --directory "$ROOT_DIR" >"$SERVER_LOG" 2>&1 &
  SERVER_PID="$!"
  wait_for_url "$TARGET_URL"
fi

echo "Updating ${#STOP_CODES[@]} example PNG(s) from ${TARGET_URL}"

node - "$TARGET_URL" "$EXAMPLES_DIR" "$SETTLE_MS" "$MAX_RENDER_ATTEMPTS" "$STABILIZE_PAUSE_MS" "$SIGN_FOOTER_URL" "${STOP_CODES[@]}" <<'NODE'
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const [, , targetUrl, examplesDir, settleMsRaw, maxRenderAttemptsRaw, stabilizePauseMsRaw, signFooterUrlRaw, ...codes] = process.argv;
const settleMs = Math.max(0, Number(settleMsRaw) || 0);
const maxRenderAttempts = Math.max(2, Number(maxRenderAttemptsRaw) || 2);
const stabilizePauseMs = Math.max(0, Number(stabilizePauseMsRaw) || 0);
const signFooterUrl = String(signFooterUrlRaw || "").trim();

async function waitForAppReady(page) {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (
    typeof stops !== "undefined"
    && Array.isArray(stops)
    && stops.length > 0
    && typeof getRouteSummaryForStop === "function"
    && typeof drawSign === "function"
    && typeof signRenderToken !== "undefined"
    && !!document.getElementById("signCanvas")
    && String(document.getElementById("progressText")?.textContent || "").includes("Ready.")
  ), null, { timeout: 240000 });
}

async function renderStopPng(page, stopCode) {
  return page.evaluate(async ({
    code,
    settleMsValue,
    maxRenderAttemptsValue,
    stabilizePauseMsValue,
  }) => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const canvas = document.getElementById("signCanvas");
    if (!canvas) return { ok: false, error: "signCanvas not found" };

    const allStops = Array.isArray(stops) ? stops : [];
    const wanted = String(code).trim();
    const stop = allStops.find((s) => String(s?.stop_code || "").trim() === wanted)
      || allStops.find((s) => String(s?.stop_id || "").trim() === wanted);
    if (!stop) return { ok: false, error: `No stop found for code/id ${wanted}` };

    const directionFilter = (typeof FIXED_DIRECTION_FILTER === "string" && FIXED_DIRECTION_FILTER)
      ? FIXED_DIRECTION_FILTER
      : "all";
    const outputScale = Math.max(1, Math.min(3, Number(FIXED_EXPORT_SCALE) || 3));
    const showStops = !!showStopsOnSign;

    selectedStop = stop;
    const items = getRouteSummaryForStop(stop, directionFilter);
    selectedStopRouteSummary = items;
    const maxRoutes = Math.max(0, Array.isArray(items) ? items.length : 0);

    let previousDataUrl = "";
    let finalDataUrl = "";
    let attemptsUsed = 0;
    for (let attempt = 1; attempt <= maxRenderAttemptsValue; attempt += 1) {
      const renderToken = ++signRenderToken;
      await drawSign({
        stop,
        items,
        directionFilter,
        maxRoutes,
        renderToken,
        outputScale,
        showStops,
      });
      if (renderToken !== signRenderToken) {
        return { ok: false, error: `Render for stop ${wanted} was superseded unexpectedly.` };
      }

      if (settleMsValue > 0) {
        await wait(settleMsValue);
      }

      const currentDataUrl = canvas.toDataURL("image/png");
      finalDataUrl = currentDataUrl;
      attemptsUsed = attempt;

      if (previousDataUrl && currentDataUrl === previousDataUrl) {
        return {
          ok: true,
          dataUrl: finalDataUrl,
          stopName: String(stop.stop_name || ""),
          stopCode: String(stop.stop_code || stop.stop_id || wanted),
          attemptsUsed,
        };
      }
      previousDataUrl = currentDataUrl;

      if (attempt < maxRenderAttemptsValue && stabilizePauseMsValue > 0) {
        await wait(stabilizePauseMsValue);
      }
    }

    return {
      ok: false,
      error: `Render for stop ${wanted} did not stabilize after ${maxRenderAttemptsValue} full render attempts.`,
    };
  }, {
    code: stopCode,
    settleMsValue: settleMs,
    maxRenderAttemptsValue: maxRenderAttempts,
    stabilizePauseMsValue: stabilizePauseMs,
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1900 } });

  try {
    await waitForAppReady(page);
    if (signFooterUrl) {
      await page.evaluate((url) => {
        window.SIGN_FOOTER_CONTRIBUTION_URL = String(url || "");
      }, signFooterUrl);
    }
    for (const code of codes) {
      const result = await renderStopPng(page, code);
      if (!result.ok) {
        throw new Error(result.error || `Failed to render ${code}`);
      }
      const base64 = String(result.dataUrl || "").replace(/^data:image\/png;base64,/, "");
      if (!base64) {
        throw new Error(`Missing PNG data for ${code}`);
      }
      const outPath = path.join(examplesDir, `#${code}.png`);
      await fs.writeFile(outPath, Buffer.from(base64, "base64"));
      process.stdout.write(`Updated examples/#${code}.png (${result.stopName || "Unknown stop"}, ${result.attemptsUsed} render pass${result.attemptsUsed === 1 ? "" : "es"})\n`);
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
NODE

echo "Done."
