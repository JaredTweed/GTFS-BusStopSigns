#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIP_PATH="${1:-${ROOT_DIR}/google_transit.zip}"
OUT_PATH="${2:-${ROOT_DIR}/preloaded_route_summaries.json}"
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

download_gtfs_zip "$GTFS_URL" "$ZIP_PATH"

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


def get_last_7_dates():
    today = dt.date.today()
    return [today - dt.timedelta(days=i) for i in range(6, -1, -1)]


def to_ymd_key(d):
    return int(f"{d.year:04d}{d.month:02d}{d.day:02d}")


def build_service_active_dates_last_week(calendar_rows, calendar_date_rows):
    week = get_last_7_dates()
    week_keys = {to_ymd_key(d) for d in week}
    weekday_by_key = {to_ymd_key(d): d.weekday() for d in week}  # Mon=0..Sun=6
    out = {}

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
        sid = row.get("service_id")
        if not sid:
            continue
        start = parse_date_key(row.get("start_date"))
        end = parse_date_key(row.get("end_date"))
        if start is None or end is None:
            continue
        s = out.setdefault(sid, set())
        for d in week:
            key = to_ymd_key(d)
            if key < start or key > end:
                continue
            weekday = d.weekday()
            col = weekday_cols[weekday]
            if str(row.get(col, "0")).strip() == "1":
                s.add(key)

    for row in calendar_date_rows:
        sid = row.get("service_id")
        key = parse_date_key(row.get("date"))
        ex_type = str(row.get("exception_type", "")).strip()
        if not sid or key is None or key not in week_keys:
            continue
        s = out.setdefault(sid, set())
        if ex_type == "1":
            s.add(key)
        elif ex_type == "2":
            s.discard(key)

    return out, weekday_by_key


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


with zipfile.ZipFile(ZIP_PATH, "r") as zf:
    stops = read_csv_rows(zf, "stops.txt")
    routes = read_csv_rows(zf, "routes.txt")
    trips = read_csv_rows(zf, "trips.txt")
    calendar = read_csv_rows(zf, "calendar.txt")
    calendar_dates = read_csv_rows(zf, "calendar_dates.txt")

    routes_by_id = {r.get("route_id"): r for r in routes if r.get("route_id")}
    trips_by_id = {}
    for t in trips:
        tid = t.get("trip_id")
        if not tid:
            continue
        trips_by_id[tid] = {
            "route_id": t.get("route_id"),
            "direction_id": str(t.get("direction_id", "") or ""),
            "trip_headsign": t.get("trip_headsign") or "",
            "shape_id": str(t.get("shape_id", "") or ""),
            "service_id": str(t.get("service_id", "") or ""),
        }

    has_service_calendar_data = bool(calendar or calendar_dates)
    service_dates_by_id, weekday_by_date = build_service_active_dates_last_week(calendar, calendar_dates)

    # stop_id -> trip_id -> earliest departure seconds
    stop_trip_time = {}
    for row in iter_csv_rows(zf, "stop_times.txt"):
        stop_id = row.get("stop_id")
        trip_id = row.get("trip_id")
        if not stop_id or not trip_id:
            continue
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

    stop_ids = [s.get("stop_id") for s in stops if s.get("stop_id")]
    stop_ids_set = set(stop_ids)
    stop_ids.extend([sid for sid in stop_trip_time.keys() if sid not in stop_ids_set])

    output_stops = {}
    for stop_id in stop_ids:
        trips_for_stop = stop_trip_time.get(stop_id, {})
        agg_all = {}

        for trip_id, dep_sec in trips_for_stop.items():
            t = trips_by_id.get(trip_id)
            if not t:
                continue

            service_dates = service_dates_by_id.get(t["service_id"], set())
            if has_service_calendar_data and not service_dates:
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
                if service_dates:
                    for date_key in service_dates:
                        weekday = weekday_by_date.get(date_key)
                        if weekday is None:
                            continue
                        cur["times"].append(dep_sec)
                        group_key = day_group_key_from_weekday(weekday)
                        cur["timesByGroup"][group_key].append(dep_sec)
                else:
                    cur["times"].append(dep_sec)

        all_items = build_summary_items(agg_all, routes_by_id)
        if all_items:
            output_stops[stop_id] = [encode_compact_summary_item(item) for item in all_items]

    out = {
        "version": 2,
        "generated_at": dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source_zip": os.path.basename(ZIP_PATH),
        "item_fields": COMPACT_ITEM_FIELDS,
        "stops": output_stops,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))

print(f"Wrote {OUT_PATH}")
PY

echo "Preload file updated: ${OUT_PATH}"
