#!/usr/bin/env python3
"""Download the AC Transit GTFS feed and extract route geometries to GeoJSON."""

import csv
import io
import json
import os
import sys
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone


def download_gtfs(token: str) -> zipfile.ZipFile:
    url = f"https://api.actransit.org/transit/gtfs/download?token={token}"
    req = urllib.request.Request(url)
    resp = urllib.request.urlopen(req, timeout=120)
    return zipfile.ZipFile(io.BytesIO(resp.read()))


def read_csv(zf: zipfile.ZipFile, filename: str) -> list[dict]:
    try:
        with zf.open(filename) as f:
            reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            return list(reader)
    except KeyError:
        return []


def get_vintage_dates(zf: zipfile.ZipFile) -> tuple[str, str]:
    """Return (feed_start_date, feed_end_date) from feed_info.txt or calendar.txt."""
    feed_info = read_csv(zf, "feed_info.txt")
    if feed_info:
        row = feed_info[0]
        start = row.get("feed_start_date", "")
        end = row.get("feed_end_date", "")
        if start and end:
            return start, end

    calendar = read_csv(zf, "calendar.txt")
    if calendar:
        starts = [r["start_date"] for r in calendar if r.get("start_date")]
        ends = [r["end_date"] for r in calendar if r.get("end_date")]
        if starts and ends:
            return min(starts), max(ends)

    return "", ""


def fmt_date(raw: str) -> str:
    """Format YYYYMMDD as YYYY-MM-DD."""
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw


def read_existing_vintage(geojson_path: str) -> str | None:
    """Read the gtfs_vintage field from an existing GeoJSON file, or None."""
    try:
        with open(geojson_path) as f:
            data = json.load(f)
        return data.get("gtfs_vintage")
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def set_output(key: str, value: str) -> None:
    gh_output = os.environ.get("GITHUB_OUTPUT", "")
    if gh_output:
        with open(gh_output, "a") as f:
            f.write(f"{key}={value}\n")


def build_geojson(zf: zipfile.ZipFile, vintage: str, start_fmt: str, end_fmt: str) -> dict:
    shapes_rows = read_csv(zf, "shapes.txt")
    trips_rows = read_csv(zf, "trips.txt")
    routes_rows = read_csv(zf, "routes.txt")

    if not shapes_rows or not trips_rows or not routes_rows:
        raise RuntimeError("GTFS zip is missing shapes.txt, trips.txt, or routes.txt")

    shapes: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for r in shapes_rows:
        shapes[r["shape_id"]].append((
            int(r["shape_pt_sequence"]),
            float(r["shape_pt_lon"]),
            float(r["shape_pt_lat"]),
        ))
    for pts in shapes.values():
        pts.sort()

    route_meta: dict[str, dict] = {}
    for r in routes_rows:
        route_meta[r["route_id"]] = r

    route_shapes: dict[str, set[str]] = defaultdict(set)
    for t in trips_rows:
        sid = t.get("shape_id", "")
        rid = t.get("route_id", "")
        if sid and rid:
            route_shapes[rid].add(sid)

    features = []
    for route_id in sorted(route_meta):
        sids = route_shapes.get(route_id)
        if not sids:
            continue
        best_sid = max(sids, key=lambda s: len(shapes.get(s, [])))
        pts = shapes.get(best_sid, [])
        if len(pts) < 2:
            continue
        coords = [[lon, lat] for _, lon, lat in pts]

        meta = route_meta[route_id]
        props = {
            "route_id": route_id,
            "route_short_name": meta.get("route_short_name", ""),
            "route_long_name": meta.get("route_long_name", ""),
            "route_color": meta.get("route_color", ""),
            "route_type": meta.get("route_type", ""),
            "agency_id": meta.get("agency_id", ""),
        }
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": props,
        })

    return {
        "type": "FeatureCollection",
        "gtfs_feed_start_date": start_fmt,
        "gtfs_feed_end_date": end_fmt,
        "gtfs_vintage": vintage,
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "features": features,
    }


def main() -> None:
    token = os.environ.get("ACTRANSIT_API_TOKEN", "")
    if not token:
        print("::error::ACTRANSIT_API_TOKEN is not set")
        sys.exit(1)

    print("Downloading GTFS feed…")
    try:
        zf = download_gtfs(token)
    except Exception as exc:
        print(f"::error::Failed to download GTFS feed: {exc}")
        sys.exit(2)

    start_raw, end_raw = get_vintage_dates(zf)
    start_fmt, end_fmt = fmt_date(start_raw), fmt_date(end_raw)
    vintage = f"{start_fmt} to {end_fmt}" if start_fmt and end_fmt else "unknown"
    print(f"  feed vintage: {vintage}")

    set_output("vintage", vintage)

    out_path = os.path.join(os.environ.get("GITHUB_WORKSPACE", "."), "latest_routes.geojson")
    existing_vintage = read_existing_vintage(out_path)

    if existing_vintage == vintage:
        print(f"Vintage unchanged ({vintage}), skipping GeoJSON rebuild.")
        set_output("changed", "false")
        return

    print(f"New vintage detected (was {existing_vintage!r}, now {vintage!r}). Building GeoJSON…")
    geojson = build_geojson(zf, vintage, start_fmt, end_fmt)
    print(f"  {len(geojson['features'])} routes extracted")

    with open(out_path, "w") as f:
        json.dump(geojson, f)
    print(f"Wrote {out_path}")

    set_output("changed", "true")


if __name__ == "__main__":
    main()
