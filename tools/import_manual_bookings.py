#!/usr/bin/env python3
from __future__ import annotations
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET
import re
import json
import hashlib
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen
from urllib.error import HTTPError

DEFAULT_WORKBOOK = Path(r"C:\Users\casto\Downloads\Pickle-Bliss-Court-2026-Pickleball-Booking.xlsx")
CONFIG = Path("supabase-config.js")
NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkgrel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
TIME_SLOTS = {
    2: (8, "8:00 AM", "9:00 AM"),
    3: (9, "9:00 AM", "10:00 AM"),
    4: (10, "10:00 AM", "11:00 AM"),
    5: (11, "11:00 AM", "12:00 PM"),
    6: (12, "12:00 PM", "1:00 PM"),
    7: (13, "1:00 PM", "2:00 PM"),
    8: (14, "2:00 PM", "3:00 PM"),
    9: (15, "3:00 PM", "4:00 PM"),
    10: (16, "4:00 PM", "5:00 PM"),
    11: (17, "5:00 PM", "6:00 PM"),
    12: (18, "6:00 PM", "7:00 PM"),
    13: (19, "7:00 PM", "8:00 PM"),
    14: (20, "8:00 PM", "9:00 PM"),
    15: (21, "9:00 PM", "10:00 PM"),
    16: (22, "10:00 PM", "11:00 PM"),
    17: (23, "11:00 PM", "12:00 AM"),
}
COURT_BLOCKS = [(1, 2, 32), (2, 36, 66), (3, 71, 101)]
EXCEL_EPOCH = datetime(1899, 12, 30)


def col_to_num(col: str) -> int:
    n = 0
    for ch in col:
        n = n * 26 + ord(ch.upper()) - 64
    return n


def parts(ref: str):
    m = re.match(r"([A-Z]+)(\d+)", ref or "")
    return (col_to_num(m.group(1)), int(m.group(2))) if m else (None, None)


def clean_text(v) -> str:
    s = str(v or "").strip()
    s = re.sub(r"\s+", " ", s)
    return s


def excel_serial_to_date(serial: int) -> str:
    return (EXCEL_EPOCH + timedelta(days=int(serial))).date().isoformat()


def parse_config():
    text = CONFIG.read_text(encoding="utf-8")
    url = re.search(r"const SUPABASE_URL = '([^']+)'", text).group(1)
    key = re.search(r"const SUPABASE_ANON_KEY = '([^']+)'", text).group(1)
    return url.rstrip("/"), key


def request_json(method: str, url: str, key: str, body=None, extra_headers=None):
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(url, data=data, method=method, headers=headers)
    try:
        with urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {e.reason}: {raw}") from e


def load_shared_strings(z: ZipFile):
    try:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    out = []
    for si in root.findall("main:si", NS):
        out.append("".join((t.text or "") for t in si.iter("{%s}t" % NS["main"])))
    return out


def cell_value(c, sst):
    t = c.attrib.get("t")
    v = c.find("main:v", NS)
    f = c.find("main:f", NS)
    if t == "inlineStr":
        is_el = c.find("main:is", NS)
        return "".join((x.text or "") for x in (is_el.iter("{%s}t" % NS["main"]) if is_el is not None else []))
    if v is None:
        return {"formula": f.text or ""} if f is not None else ""
    raw = v.text or ""
    if t == "s":
        try:
            return sst[int(raw)]
        except Exception:
            return raw
    return raw


def load_sheets(path: Path):
    with ZipFile(path) as z:
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        rel_map = {r.attrib["Id"]: r.attrib["Target"] for r in rels.findall("pkgrel:Relationship", NS)}
        sst = load_shared_strings(z)
        sheets = {}
        for sheet in wb.findall("main:sheets/main:sheet", NS):
            name = sheet.attrib["name"]
            rid = sheet.attrib["{%s}id" % NS["rel"]]
            target = rel_map[rid]
            sheet_path = "xl/" + target.lstrip("/") if not target.startswith("xl/") else target
            root = ET.fromstring(z.read(sheet_path))
            rows = {}
            for row in root.findall("main:sheetData/main:row", NS):
                rnum = int(row.attrib.get("r", "0") or 0)
                rowdict = {}
                for c in row.findall("main:c", NS):
                    col, _ = parts(c.attrib.get("r", ""))
                    if col:
                        rowdict[col] = cell_value(c, sst)
                rows[rnum] = rowdict
            sheets[name] = rows
        return sheets


def date_for_row(rows, r: int, first_row: int) -> str | None:
    dates = {}
    prev = None
    for row_num in range(first_row, r + 1):
        raw = rows.get(row_num, {}).get(1, "")
        if isinstance(raw, dict):
            serial = (prev + 1) if prev is not None else None
        else:
            try:
                serial = int(float(str(raw)))
            except Exception:
                serial = (prev + 1) if prev is not None else None
        if serial is None:
            dates[row_num] = None
        else:
            dates[row_num] = excel_serial_to_date(serial)
            prev = serial
    return dates.get(r)


def make_ref(sheet_name, court_num, date, name, slots):
    key = f"{sheet_name}|Court {court_num}|{date}|{name}|{','.join(map(str, slots))}"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10].upper()
    ymd = date.replace("-", "")
    return f"MANUAL-{ymd}-C{court_num}-{slots[0]}-{digest}"


def parse_candidates(courts_by_name, workbook: Path):
    sheets = load_sheets(workbook)
    candidates = []
    skipped_cells = []
    for sheet_name, rows in sheets.items():
        for court_num, first_row, last_row in COURT_BLOCKS:
            court_name = f"Court {court_num}"
            court = courts_by_name.get(court_name.lower())
            if not court:
                raise RuntimeError(f"No live court found for {court_name}")
            for r in range(first_row, last_row + 1):
                date = date_for_row(rows, r, first_row)
                if not date:
                    continue
                col = 2
                while col <= 17:
                    raw = rows.get(r, {}).get(col, "")
                    name = clean_text(raw if not isinstance(raw, dict) else "")
                    if not name:
                        col += 1
                        continue
                    if name.startswith("=") or name in {"0", "300", "350"}:
                        skipped_cells.append({"sheet": sheet_name, "row": r, "col": col, "value": name, "reason": "not_booking_text"})
                        col += 1
                        continue
                    start_col = col
                    slots = []
                    while col <= 17:
                        nxt = clean_text(rows.get(r, {}).get(col, ""))
                        if nxt != name:
                            break
                        slots.append(TIME_SLOTS[col][0])
                        col += 1
                    start_hour = slots[0]
                    end_hour = slots[-1] + 1
                    start_time = TIME_SLOTS[start_col][1]
                    end_time = "12:00 AM" if end_hour == 24 else TIME_SLOTS[start_col + len(slots) - 1][2]
                    candidates.append({
                        "ref": make_ref(sheet_name, court_num, date, name, slots),
                        "full_name": name,
                        "contact_number": "",
                        "email": "",
                        "court_id": court["id"],
                        "court_name": court["name"],
                        "date": date,
                        "slots": [str(s) for s in slots],
                        "start_time": start_time,
                        "end_time": end_time,
                        "duration": len(slots),
                        "rate": 0,
                        "total": 0,
                        "downpayment": 0,
                        "payment_method": "manual",
                        "payment_status": "unpaid",
                        "status": "confirmed",
                        "created_at": datetime.now(timezone.utc).isoformat(),
                    })
    return candidates, skipped_cells


def slot_set(row):
    return {str(x) for x in (row.get("slots") or [])}


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook", default=str(DEFAULT_WORKBOOK))
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--out", default="manual-booking-import-preview.json")
    args = parser.parse_args()

    workbook = Path(args.workbook)
    if not workbook.exists():
        raise SystemExit(f"Workbook not found: {workbook}")

    url, key = parse_config()
    courts = request_json("GET", f"{url}/rest/v1/courts?select=id,name,rate,blocked&order=id", key)
    courts_by_name = {clean_text(c["name"]).lower(): c for c in courts}
    candidates, skipped_cells = parse_candidates(courts_by_name, workbook)

    existing = request_json(
        "GET",
        f"{url}/rest/v1/bookings?select=ref,court_id,court_name,date,slots,status,full_name&date=gte.2026-06-01&date=lte.2026-08-31",
        key,
    )
    existing_refs = {b.get("ref") for b in existing}
    active_existing = [b for b in existing if b.get("status") != "cancelled"]

    to_insert = []
    duplicate_refs = []
    conflicts = []
    for row in candidates:
        if row["ref"] in existing_refs:
            duplicate_refs.append(row)
            continue
        row_slots = slot_set(row)
        conflict = next((b for b in active_existing
                         if b.get("court_id") == row["court_id"]
                         and b.get("date") == row["date"]
                         and slot_set(b) & row_slots), None)
        if conflict:
            conflicts.append({"candidate": row, "existing": conflict})
            continue
        to_insert.append(row)

    summary = {
        "workbook": str(workbook),
        "courts": courts,
        "candidates": len(candidates),
        "to_insert": len(to_insert),
        "duplicate_refs_skipped": len(duplicate_refs),
        "conflicts_skipped": len(conflicts),
        "skipped_cells": len(skipped_cells),
        "by_month": {},
        "by_court": {},
        "conflicts_sample": conflicts[:20],
        "insert_sample": to_insert[:20],
    }
    for row in candidates:
        ym = row["date"][:7]
        summary["by_month"][ym] = summary["by_month"].get(ym, 0) + 1
        summary["by_court"][row["court_name"]] = summary["by_court"].get(row["court_name"], 0) + 1

    Path(args.out).write_text(json.dumps({"summary": summary, "to_insert": to_insert}, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.apply and to_insert:
        inserted = 0
        for i in range(0, len(to_insert), 100):
            chunk = to_insert[i:i+100]
            request_json("POST", f"{url}/rest/v1/bookings", key, chunk, {"Prefer": "return=minimal"})
            inserted += len(chunk)
        summary["inserted"] = inserted
        Path(args.out).write_text(json.dumps({"summary": summary, "to_insert": to_insert}, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
