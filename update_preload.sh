#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIP_PATH="${1:-${ROOT_DIR}/google_transit.zip}"
OUT_PATH="${2:-${ROOT_DIR}/preloaded_route_summaries.json}"
GTFS_DIR="${3:-${ROOT_DIR}/google_transit}"
GTFS_URL="${GTFS_URL:-https://gtfs-static.translink.ca/gtfs/google_transit.zip}"

download_gtfs_zip() {
    local url="$1"
    local out="$2"
    local tmp

    mkdir -p "$(dirname "$out")"
    tmp="$(mktemp "${out}.tmp.XXXXXX")"

    if command -v curl >/dev/null 2>&1; then
        curl --fail --location --silent --show-error "$url" --output "$tmp"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$tmp" "$url"
    else
        echo "Error: curl or wget is required to download GTFS data." >&2
        rm -f "$tmp"
        return 1
    fi

    mv "$tmp" "$out"
    echo "Updated GTFS zip: ${out}"
}

refresh_gtfs_folder() {
    local zip_path="$1"
    local out_dir="$2"

    mkdir -p "$out_dir"

    python3 - "$zip_path" "$out_dir" <<'PY'
import os
import shutil
import sys
import zipfile

zip_path = sys.argv[1]
out_dir = sys.argv[2]

for name in os.listdir(out_dir):
    path = os.path.join(out_dir, name)
    if os.path.isdir(path):
        shutil.rmtree(path)
    else:
        os.remove(path)

with zipfile.ZipFile(zip_path, "r") as zf:
    zf.extractall(out_dir)
PY

    echo "Updated GTFS folder: ${out_dir}"
}

download_gtfs_zip "$GTFS_URL" "$ZIP_PATH"
refresh_gtfs_folder "$ZIP_PATH" "$GTFS_DIR"

python3 - "$ZIP_PATH" "$OUT_PATH" <<'PY'
import csv
import datetime as dt
import io
import json
import os
import sys
import zipfile


ZIP_PATH = sys.argv[1]
OUT_PATH = sys.argv[2]


def parse_time_to_seconds(raw):
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    parts = s.split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        h = int(parts[0])
        m = int(parts[1])
        sec = int(parts[2]) if len(parts) == 3 else 0
    except ValueError:
        return None
    if h < 0 or m < 0 or m > 59 or sec < 0 or sec > 59:
        return None
    return (h * 3600) + (m * 60) + sec


def format_clock(sec):
    if sec is None:
        return ""
    raw = int(sec)
    day = 24 * 3600
    day_offset = (raw // day) if raw >= 0 else 0
    t = ((raw % day) + day) % day
    h24 = t // 3600
    m = (t % 3600) // 60
    h12 = ((h24 + 11) % 12) + 1
    ampm = "pm" if h24 >= 12 else "am"
    base = f"{h12}:{m:02d}{ampm}"
    return f"{base}+{day_offset}" if day_offset > 0 else base


def build_active_hours_text(times_sec):
    sorted_times = sorted(x for x in times_sec if isinstance(x, (int, float)))
    if not sorted_times:
        return ""
    if len(sorted_times) == 1:
        return format_clock(sorted_times[0])
    return f"{format_clock(sorted_times[0])}-{format_clock(sorted_times[-1])}"


def build_grouped_active_hours_text(times_by_group, fallback_times):
    ordered = [("monfri", "Mon-Fri"), ("sat", "Sat"), ("sun", "Sun")]
    parts = []
    for key, label in ordered:
        r = build_active_hours_text(times_by_group.get(key, []))
        if r:
            parts.append(f"{label} ({r})")
    if parts:
        return ", ".join(parts)
    fallback = build_active_hours_text(fallback_times)
    return f"All days ({fallback})" if fallback else ""


def day_group_key_from_weekday(weekday):
    if weekday == 6:
        return "sun"
    if weekday == 5:
        return "sat"
    return "monfri"


def parse_date_key(v):
    if v is None:
        return None
    s = str(v).strip()
    if len(s) != 8 or not s.isdigit():
        return None
    return int(s)


def normalize_color(value, fallback="#3b82f6"):
    if not value:
        return fallback
    v = str(value).strip().replace("#", "")
    if len(v) == 6 and all(c in "0123456789abcdefABCDEF" for c in v):
        return f"#{v}"
    if len(v) == 3 and all(c in "0123456789abcdefABCDEF" for c in v):
        return f"#{v}"
    return fallback


def read_csv_rows(zf, name):
    try:
        with zf.open(name, "r") as fh:
            txt = io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")
            return list(csv.DictReader(txt))
    except KeyError:
        return []


def iter_csv_rows(zf, name):
    with zf.open(name, "r") as fh:
        txt = io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(txt)
        for row in reader:
            yield row


def date_from_key(date_key):
    if date_key is None:
        return None
    raw = str(int(date_key)).zfill(8)
    try:
        return dt.date(int(raw[0:4]), int(raw[4:6]), int(raw[6:8]))
    except ValueError:
        return None


def date_key_from_date(d):
    return int(f"{d.year:04d}{d.month:02d}{d.day:02d}")


def iter_date_keys(start_key, end_key):
    start = date_from_key(start_key)
    end = date_from_key(end_key)
    if start is None or end is None or end < start:
        return
    cur = start
    step = dt.timedelta(days=1)
    while cur <= end:
        yield date_key_from_date(cur), cur.weekday()  # Monday=0..Sunday=6
        cur += step


def build_service_active_weekdays(calendar_rows, calendar_date_rows):
    calendar_by_service = {}
    exceptions_by_service = {}

    weekday_cols = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ]

    for row in calendar_rows:
        sid = str(row.get("service_id") or "").strip()
        if not sid:
            continue
        start = parse_date_key(row.get("start_date"))
        end = parse_date_key(row.get("end_date"))
        if start is None or end is None or end < start:
            continue
        flags = [str(row.get(col, "0")).strip() == "1" for col in weekday_cols]
        calendar_by_service.setdefault(sid, []).append({
            "start": start,
            "end": end,
            "flags": flags,
        })

    for row in calendar_date_rows:
        sid = str(row.get("service_id") or "").strip()
        key = parse_date_key(row.get("date"))
        ex_type = str(row.get("exception_type") or "").strip()
        if not sid or key is None or ex_type not in ("1", "2"):
            continue
        exceptions_by_service.setdefault(sid, {})[key] = ex_type

    service_ids = set(calendar_by_service.keys()) | set(exceptions_by_service.keys())
    out = {}

    for sid in service_ids:
        rows = calendar_by_service.get(sid, [])
        by_date = exceptions_by_service.get(sid, {})

        min_key = None
        max_key = None
        for row in rows:
            start = row["start"]
            end = row["end"]
            min_key = start if min_key is None else min(min_key, start)
            max_key = end if max_key is None else max(max_key, end)
        for key in by_date.keys():
            min_key = key if min_key is None else min(min_key, key)
            max_key = key if max_key is None else max(max_key, key)

        if min_key is None or max_key is None:
            continue

        weekdays = set()
        for date_key, weekday in iter_date_keys(min_key, max_key):
            is_active = False
            for row in rows:
                if date_key < row["start"] or date_key > row["end"]:
                    continue
                if row["flags"][weekday]:
                    is_active = True
                    break

            ex_type = by_date.get(date_key)
            if ex_type == "1":
                is_active = True
            elif ex_type == "2":
                is_active = False

            if is_active:
                weekdays.add(weekday)
            if len(weekdays) >= 7:
                break

        if weekdays:
            out[sid] = weekdays

    return out


def build_summary_items(agg_items, routes_by_id):
    items = []
    for x in agg_items.values():
        route = routes_by_id.get(x["route_id"], {})
        short_name = str(route.get("route_short_name", "") or "").strip()

        shape_id = None
        shape_max = -1
        for cand, n in x["shapeCounts"].items():
            if n > shape_max:
                shape_id = cand
                shape_max = n

        headsign = ""
        headsign_max = -1
        for cand, n in x["headsignCounts"].items():
            if n > headsign_max:
                headsign = cand
                headsign_max = n

        items.append(
            {
                "route_id": x["route_id"],
                "direction_id": x["direction_id"],
                "headsign": headsign,
                "count": x["count"],
                "shape_id": shape_id,
                "route_short_name": short_name,
                "route_color": normalize_color(route.get("route_color"), "#3b82f6"),
                "active_hours_text": build_grouped_active_hours_text(x["timesByGroup"], x["times"]),
            }
        )

    def sort_key(item):
        short = item.get("route_short_name", "") or ""
        try:
            n = int(short)
            return (0, n, short)
        except ValueError:
            return (1, 0, short)

    items.sort(key=lambda i: (-i.get("count", 0), sort_key(i)))
    return items


COMPACT_ITEM_FIELDS = [
    "route_id",
    "direction_id",
    "headsign",
    "count",
    "shape_id",
    "route_short_name",
    "route_color",
    "active_hours_text",
]


def encode_compact_summary_item(item):
    return [item.get(field) for field in COMPACT_ITEM_FIELDS]


STOP_OVERLAY_TRIP_CANDIDATE_LIMIT = 24


def normalize_headsign_key(v):
    return str(v or "").strip().lower()


def route_shape_direction_key(route_id, shape_id, direction_id):
    return f"{route_id or ''}::{shape_id or ''}::{direction_id or ''}"


def route_shape_key_only(route_id, shape_id):
    return f"{route_id or ''}::{shape_id or ''}"


def route_shape_direction_headsign_key(route_id, shape_id, direction_id, headsign):
    return f"{route_shape_direction_key(route_id, shape_id, direction_id)}::{normalize_headsign_key(headsign)}"


def add_trip_candidate(index_obj, key, trip_id):
    if not key or not trip_id:
        return
    arr = index_obj.setdefault(key, [])
    if trip_id not in arr:
        arr.append(trip_id)


def trip_candidate_ids_for_summary_item(item, by_rsdh, by_rsd, by_rs):
    route_id = str(item.get("route_id") or "").strip()
    shape_id = str(item.get("shape_id") or "").strip()
    if not route_id or not shape_id:
        return []

    direction_raw = item.get("direction_id")
    direction_id = "" if direction_raw is None else str(direction_raw).strip()
    headsign = str(item.get("headsign") or "").strip()

    keys = [
        route_shape_direction_headsign_key(route_id, shape_id, direction_id, headsign),
        route_shape_direction_key(route_id, shape_id, direction_id),
        route_shape_key_only(route_id, shape_id),
    ]
    pools = [by_rsdh, by_rsd, by_rs]

    out = []
    seen = set()
    for idx, key in enumerate(keys):
        for trip_id in pools[idx].get(key, []):
            if trip_id in seen:
                continue
            seen.add(trip_id)
            out.append(trip_id)
            if len(out) >= STOP_OVERLAY_TRIP_CANDIDATE_LIMIT:
                return out
    return out


def build_downstream_stop_ids(stop_id, trip_stop_ids):
    if not stop_id or not trip_stop_ids:
        return []
    sid = str(stop_id)
    try:
        start_idx = trip_stop_ids.index(sid)
    except ValueError:
        return []

    out = []
    seen = set()
    for raw in trip_stop_ids[start_idx + 1 :]:
        next_sid = str(raw or "")
        if not next_sid or next_sid == sid or next_sid in seen:
            continue
        seen.add(next_sid)
        out.append(next_sid)
    return out


with zipfile.ZipFile(ZIP_PATH, "r") as zf:
    stops = read_csv_rows(zf, "stops.txt")
    routes = read_csv_rows(zf, "routes.txt")
    trips = read_csv_rows(zf, "trips.txt")
    calendar = read_csv_rows(zf, "calendar.txt")
    calendar_dates = read_csv_rows(zf, "calendar_dates.txt")

    routes_by_id = {r.get("route_id"): r for r in routes if r.get("route_id")}
    trips_by_id = {}
    candidate_trips_by_rsdh = {}
    candidate_trips_by_rsd = {}
    candidate_trips_by_rs = {}
    for t in trips:
        tid = t.get("trip_id")
        if not tid:
            continue
        route_id = t.get("route_id")
        direction_id = str(t.get("direction_id", "") or "")
        trip_headsign = t.get("trip_headsign") or ""
        shape_id = str(t.get("shape_id", "") or "")
        service_id = str(t.get("service_id", "") or "")
        trips_by_id[tid] = {
            "route_id": route_id,
            "direction_id": direction_id,
            "trip_headsign": trip_headsign,
            "shape_id": shape_id,
            "service_id": service_id,
        }

        rid = str(route_id or "").strip()
        sid = str(shape_id or "").strip()
        if rid and sid:
            add_trip_candidate(
                candidate_trips_by_rsdh,
                route_shape_direction_headsign_key(rid, sid, direction_id.strip(), trip_headsign),
                tid,
            )
            add_trip_candidate(
                candidate_trips_by_rsd,
                route_shape_direction_key(rid, sid, direction_id.strip()),
                tid,
            )
            add_trip_candidate(
                candidate_trips_by_rs,
                route_shape_key_only(rid, sid),
                tid,
            )

    has_service_calendar_data = bool(calendar or calendar_dates)
    service_weekdays_by_id = build_service_active_weekdays(calendar, calendar_dates)

    # stop_id -> trip_id -> earliest departure seconds
    stop_trip_time = {}
    # trip_id -> [(stop_sequence, stop_id)...] for downstream stop overlays
    trip_stop_rows = {}
    for row in iter_csv_rows(zf, "stop_times.txt"):
        stop_id = row.get("stop_id")
        trip_id = row.get("trip_id")
        if not stop_id or not trip_id:
            continue

        seq_raw = row.get("stop_sequence")
        try:
            seq = int(seq_raw)
        except (TypeError, ValueError):
            seq = None
        rows = trip_stop_rows.setdefault(trip_id, [])
        rows.append((seq if seq is not None else len(rows), str(stop_id)))

        dep = parse_time_to_seconds(row.get("departure_time"))
        if dep is None:
            dep = parse_time_to_seconds(row.get("arrival_time"))
        by_trip = stop_trip_time.setdefault(stop_id, {})
        if dep is None:
            by_trip.setdefault(trip_id, None)
            continue
        prev = by_trip.get(trip_id)
        if prev is None or dep < prev:
            by_trip[trip_id] = dep

    trip_stop_ids_by_trip = {}
    for trip_id, rows in trip_stop_rows.items():
        rows.sort(key=lambda x: x[0])
        seq_stops = []
        last_key = None
        for seq, sid in rows:
            key = f"{seq}::{sid}"
            if key == last_key:
                continue
            last_key = key
            seq_stops.append(sid)
        trip_stop_ids_by_trip[trip_id] = seq_stops

    stop_ids = [s.get("stop_id") for s in stops if s.get("stop_id")]
    stop_ids_set = set(stop_ids)
    stop_ids.extend([sid for sid in stop_trip_time.keys() if sid not in stop_ids_set])

    output_stops = {}
    output_stop_overlays = {}
    for stop_id in stop_ids:
        trips_for_stop = stop_trip_time.get(stop_id, {})
        agg_all = {}

        for trip_id, dep_sec in trips_for_stop.items():
            t = trips_by_id.get(trip_id)
            if not t:
                continue

            service_weekdays = service_weekdays_by_id.get(t["service_id"], set())
            if has_service_calendar_data and not service_weekdays:
                continue

            direction = t["direction_id"] if t["direction_id"] != "" else None
            key = (t["route_id"], direction)
            cur = agg_all.get(key)
            if cur is None:
                cur = {
                    "route_id": t["route_id"],
                    "direction_id": direction,
                    "count": 0,
                    "shapeCounts": {},
                    "headsignCounts": {},
                    "times": [],
                    "timesByGroup": {"monfri": [], "sat": [], "sun": []},
                }
                agg_all[key] = cur

            cur["count"] += 1
            if t["shape_id"]:
                cur["shapeCounts"][t["shape_id"]] = cur["shapeCounts"].get(t["shape_id"], 0) + 1

            route = routes_by_id.get(t["route_id"], {})
            headsign = (str(t["trip_headsign"]).strip() if t["trip_headsign"] else "") or route.get("route_long_name") or route.get("route_short_name") or ""
            if headsign:
                cur["headsignCounts"][headsign] = cur["headsignCounts"].get(headsign, 0) + 1

            if dep_sec is not None:
                if service_weekdays:
                    for weekday in service_weekdays:
                        cur["times"].append(dep_sec)
                        group_key = day_group_key_from_weekday(weekday)
                        cur["timesByGroup"][group_key].append(dep_sec)
                else:
                    cur["times"].append(dep_sec)

        all_items = build_summary_items(agg_all, routes_by_id)
        if all_items:
            output_stops[stop_id] = [encode_compact_summary_item(item) for item in all_items]

            overlays_for_stop = {}
            for item in all_items:
                route_id = str(item.get("route_id") or "").strip()
                shape_id = str(item.get("shape_id") or "").strip()
                if not route_id or not shape_id:
                    continue
                route_shape_key = route_shape_key_only(route_id, shape_id)
                if route_shape_key in overlays_for_stop:
                    continue

                candidates = trip_candidate_ids_for_summary_item(
                    item,
                    candidate_trips_by_rsdh,
                    candidate_trips_by_rsd,
                    candidate_trips_by_rs,
                )
                best_trip_stops = []
                best_downstream_count = -1
                for trip_id in candidates:
                    trip_stop_ids = trip_stop_ids_by_trip.get(trip_id, [])
                    if not trip_stop_ids:
                        continue
                    try:
                        idx = trip_stop_ids.index(str(stop_id))
                    except ValueError:
                        continue
                    downstream_count = len(trip_stop_ids) - idx - 1
                    if downstream_count > best_downstream_count:
                        best_trip_stops = trip_stop_ids
                        best_downstream_count = downstream_count

                downstream_stop_ids = build_downstream_stop_ids(stop_id, best_trip_stops)
                if downstream_stop_ids:
                    overlays_for_stop[route_shape_key] = downstream_stop_ids

            if overlays_for_stop:
                output_stop_overlays[stop_id] = overlays_for_stop

    out = {
        "version": 4,
        "generated_at": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source_zip": os.path.basename(ZIP_PATH),
        "item_fields": COMPACT_ITEM_FIELDS,
        "stops": output_stops,
        "stop_overlays": output_stop_overlays,
    }

    def comparable_payload(obj):
        if not isinstance(obj, dict):
            return None
        cp = dict(obj)
        cp.pop("generated_at", None)
        return cp

    existing = None
    if os.path.exists(OUT_PATH):
        try:
            with open(OUT_PATH, "r", encoding="utf-8") as fh:
                existing = json.load(fh)
        except Exception:
            existing = None

    if comparable_payload(existing) == comparable_payload(out):
        print(f"No data changes for {OUT_PATH}; keeping existing file.")
    else:
        with open(OUT_PATH, "w", encoding="utf-8") as fh:
            json.dump(out, fh, separators=(",", ":"))
        print(f"Wrote {OUT_PATH}")
PY

echo "Preload update finished: ${OUT_PATH}"
