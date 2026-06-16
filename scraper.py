r"""
TBC School Scraper

Run with the full Python path (python.exe is not on PATH by default):
  C:\Users\HP\AppData\Local\Programs\Python\Python312\python.exe scraper.py --year 2024 --schools 20349 --dry-run
  C:\Users\HP\AppData\Local\Programs\Python\Python312\python.exe scraper.py --year 2024 --schools 20349
  C:\Users\HP\AppData\Local\Programs\Python\Python312\python.exe scraper.py --year 2024
  C:\Users\HP\AppData\Local\Programs\Python\Python312\python.exe scraper.py --year 2024 --dry-run

Install dependencies (first time only):
  C:\Users\HP\AppData\Local\Programs\Python\Python312\python.exe -m pip install playwright requests
  C:\Users\HP\AppData\Local\Programs\Python\Python312\python.exe -m playwright install chromium
"""

import argparse
import json
import random
import re
import time

import requests
import gspread
from google.oauth2.service_account import Credentials
from playwright.sync_api import sync_playwright

SHEETDB_BASE = "https://sheetdb.io/api/v1/gfe1gq37xjmxy"
TBC_BASE     = "https://www.thebaseballcube.com"
SHEET_ID     = "1j11FxEEADuAvFy5pJKVsQAfJKPGO6TRTxJT6gHnDRFI"
SCOPES       = ["https://www.googleapis.com/auth/spreadsheets"]

CONF_RATINGS = {
    "ACCAC":      0.90,
    "NJCAA R14":  0.88,
    "GCAC":       0.84,
    "MCCAA":      0.79,
    "NJCAA R1":   0.90,
    "NJCAA R2":   0.80,
    "NJCAA R3":   0.74,
    "NJCAA R4":   0.82,
    "NJCAA R5":   0.84,
    "NJCAA R6":   0.86,
    "NJCAA R7":   0.76,
    "NJCAA R12":  0.79,
    "NJCAA R13":  0.80,
    "NJCAA R15":  0.83,
    "NJCAA R17":  0.85,
    "NJCAA R20":  0.86,
    "NJCAA R21":  0.84,
    "NJCAA R22":  0.83,
    "NJCAA R23":  0.81,
    "NJCAA R24":  0.80,
    "CCCAA":      0.82,
    "CCCAA-S":    0.85,
    "NWAC":       0.82,
    "WJCAC":      0.84,
    "FCSAA":      0.80,
    "SWJCAC":     0.81,
}

# ── Projection formulas ───────────────────────────────────────────────────────

def compute_proj_ops(juco_ops, conf_rating):
    norm_ops = juco_ops * conf_rating
    if norm_ops > 0.980:
        reg = max(0.62, 0.79 - (norm_ops - 0.980) * 0.22)
    elif norm_ops > 0.900:
        reg = 0.88 - (norm_ops - 0.900) * 0.12
    elif norm_ops > 0.780:
        reg = 0.91
    else:
        reg = 0.94
    proj_ops   = round(norm_ops * reg, 3)
    proj_floor = round(proj_ops - 0.062, 3)
    proj_ceil  = round(proj_ops + 0.068, 3)
    return proj_ops, proj_floor, proj_ceil


def compute_proj_era(juco_era, conf_rating, k9=0.0):
    norm_era   = juco_era / conf_rating if conf_rating else juco_era
    k_adj      = 0.94 if k9 > 10 else (1.00 if k9 > 8 else 1.08)
    proj_era   = round(norm_era * k_adj, 2)
    proj_floor = round(proj_era + 0.75, 2)
    proj_ceil  = round(max(1.80, proj_era - 0.55), 2)
    return proj_era, proj_floor, proj_ceil


def compute_gem(ops, conf_rating, avg, k_pct, bb_pct, sb, pa):
    gem = 30
    norm = ops * conf_rating
    if norm > 1.100:   gem += 40
    elif norm > 0.950: gem += 28
    elif norm > 0.850: gem += 18
    elif norm > 0.750: gem += 8
    if k_pct < 12:     gem += 10
    elif k_pct < 18:   gem += 4
    elif k_pct > 25:   gem -= 6
    if bb_pct > 12:    gem += 8
    elif bb_pct > 8:   gem += 4
    if sb > 20:        gem += 6
    elif sb > 10:      gem += 3
    if pa < 80:        gem -= 8
    return min(95, max(10, gem))


# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_float(val, default=0.0):
    try:
        return float(str(val).replace("%", "").strip())
    except (ValueError, AttributeError):
        return default


def parse_int(val, default=0):
    try:
        return int(str(val).strip())
    except (ValueError, AttributeError):
        return default


# ── Google Sheets helpers ─────────────────────────────────────────────────────

def ensure_tbcid_column():
    """Add tbcId column to Players sheet header if it doesn't already exist."""
    creds = Credentials.from_service_account_file("Credentials.json", scopes=SCOPES)
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(SHEET_ID).worksheet("Players")
    headers = ws.row_values(1)
    if "tbcId" in headers:
        print(f"  tbcId column already exists at position {headers.index('tbcId') + 1}")
    else:
        next_col = len(headers) + 1
        ws.update_cell(1, next_col, "tbcId")
        print(f"  Added tbcId column at position {next_col} (column {next_col})")


# ── SheetDB I/O ───────────────────────────────────────────────────────────────

def get_existing_players():
    """Returns (set of lowercase names, max id)."""
    try:
        r = requests.get(f"{SHEETDB_BASE}?sheet=Players&limit=2000", timeout=15)
        r.raise_for_status()
        players = r.json()
        names = {p["name"].lower().strip() for p in players if p.get("name")}
        max_id = max((int(p.get("id") or 0) for p in players), default=0)
        return names, max_id
    except Exception as e:
        print(f"  Warning: could not fetch existing players — {e}")
        return set(), 0


def push_players(players):
    try:
        r = requests.post(
            f"{SHEETDB_BASE}?sheet=Players",
            json={"data": players},
            timeout=30,
        )
        r.raise_for_status()
        return len(players)
    except Exception as e:
        print(f"  Error pushing players: {e}")
        return 0


# ── Scraper ───────────────────────────────────────────────────────────────────

def scrape_school(page, school_id, year, school_name, conf):
    url = f"{TBC_BASE}/content/stats_college/{year}~{school_id}/"
    print(f"  Fetching: {url}")

    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_selector("table", timeout=60000)
    page.wait_for_timeout(5000)  # give JS full render time

    # Pull all table data — headers, rows, and player-link IDs — in one JS call
    tables_data = page.evaluate(r"""() => {
        const tables = document.querySelectorAll('table');
        return Array.from(tables).map(t => {
            const rows = Array.from(t.querySelectorAll('tr'));
            const firstRow = rows[0];
            const headers = firstRow
                ? Array.from(firstRow.querySelectorAll('td, th')).map(c => c.textContent.trim().toLowerCase())
                : [];
            const dataRows = rows.slice(1).map(r => {
                const values = Array.from(r.querySelectorAll('td, th')).map(c => c.textContent.trim());
                const link   = r.querySelector('a[href*="/content/player/"]');
                const m      = link ? link.href.match(/\/content\/player\/(\d+)\//) : null;
                return { values, tbcId: m ? m[1] : null };
            });
            return { headers, rows: dataRows };
        });
    }""")

    conf_rating    = CONF_RATINGS.get(conf, 0.82)
    hitters        = []
    pitchers       = []
    batting_table  = None
    pitching_table = None
    roster_table   = None

    for t in tables_data:
        h = t["headers"]
        if "avg" in h and "obp" in h:
            batting_table = t
        elif "era" in h and "whip" in h:
            pitching_table = t
        elif "pos" in h and "ht" in h:
            roster_table = t

    # Build roster lookup: lowercase name -> physical/bio info
    roster = {}
    if roster_table:
        h   = roster_table["headers"]
        col = lambda n: h.index(n) if n in h else -1
        for row in roster_table["rows"]:
            v   = row["values"]
            get = lambda c, _v=v: _v[col(c)] if 0 <= col(c) < len(_v) else ""
            name = get("player").replace("*", "").strip()
            if not name:
                continue
            roster[name.lower()] = {
                "pos":      get("pos"),
                "ht":       get("ht"),
                "wt":       get("wt"),
                "bats":     get("ba"),
                "throws":   get("th"),
                "hometown": get("place"),
            }

    # Parse batting table
    if batting_table:
        h   = batting_table["headers"]
        col = lambda n: h.index(n) if n in h else -1
        for row in batting_table["rows"]:
            v      = row["values"]
            tbc_id = row["tbcId"]
            get    = lambda c, _v=v: _v[col(c)] if 0 <= col(c) < len(_v) else ""
            name   = get("player").replace("*", "").strip()
            if not name or "total" in name.lower():
                continue
            avg = parse_float(get("avg"))
            obp = parse_float(get("obp"))
            slg = parse_float(get("slg"))
            if not (0.100 <= avg <= 0.750):
                continue
            ops_str = get("ops")
            ops  = parse_float(ops_str) if ops_str else round(obp + slg, 3)
            ab   = parse_int(get("ab"))
            bb   = parse_int(get("bb"))
            so   = parse_int(get("so"))
            hr   = parse_int(get("hr"))
            sb   = parse_int(get("sb"))
            pa_s = get("pa")
            pa   = parse_int(pa_s) if pa_s else ((ab + bb) or ab)
            bb_pct_s = get("bb%")
            bb_pct   = parse_float(bb_pct_s) if bb_pct_s else (round(bb / pa * 100, 1) if pa else 0)
            k_pct_s  = get("so%")
            k_pct    = parse_float(k_pct_s)  if k_pct_s  else (round(so / pa * 100, 1) if pa else 0)
            info = roster.get(name.lower(), {})
            proj_ops, proj_floor, proj_ceil = compute_proj_ops(ops, conf_rating)
            gem  = compute_gem(ops, conf_rating, avg, k_pct, bb_pct, sb, pa)
            hitters.append({
                "tbcId":      tbc_id,
                "name":       name,
                "pos":        info.get("pos")      or "UTIL",
                "school":     school_name,
                "conf":       conf,
                "year":       year,
                "juco_avg":   avg,   "juco_obp": obp, "juco_slg": slg, "juco_ops": ops,
                "juco_pa":    pa,    "juco_hr":  hr,  "juco_sb":  sb,
                "juco_bbPct": bb_pct, "juco_kPct": k_pct,
                "proj_ops":   proj_ops, "proj_floor": proj_floor, "proj_ceil": proj_ceil,
                "gemScore": gem, "riskScore": 100 - gem,
                "isPitcher":  "false", "status": "available",
                "bats":       info.get("bats")     or "R",
                "throws":     info.get("throws")   or "R",
                "hometown":   info.get("hometown") or "",
                "ht":         info.get("ht")       or "",
                "wt":         info.get("wt")       or "",
                "age":        20,
            })

    # Parse pitching table
    if pitching_table:
        h   = pitching_table["headers"]
        col = lambda n: h.index(n) if n in h else -1
        for row in pitching_table["rows"]:
            v      = row["values"]
            tbc_id = row["tbcId"]
            get    = lambda c, _v=v: _v[col(c)] if 0 <= col(c) < len(_v) else ""
            name   = get("player").replace("*", "").strip()
            if not name or "total" in name.lower():
                continue
            era  = parse_float(get("era"))
            whip = parse_float(get("whip"))
            ip   = parse_float(get("ip"))
            if ip < 5:
                continue
            so9 = parse_float(get("so9"))
            bb9 = parse_float(get("bb9"))
            sv  = parse_int(get("sv"))
            gs  = parse_int(get("gs"))
            info       = roster.get(name.lower(), {})
            proj_era, proj_floor, proj_ceil = compute_proj_era(era, conf_rating, so9)
            gem        = min(92, max(12, round(88 - era * 8 - whip * 3 + so9 * 1.2)))
            roster_pos = info.get("pos") or ""
            pos        = roster_pos if roster_pos in ("SP", "RP") else ("RP" if sv > 3 else ("SP" if gs > 3 else "RP"))
            pitchers.append({
                "tbcId":      tbc_id,
                "name":       name,
                "pos":        pos,
                "school":     school_name,
                "conf":       conf,
                "year":       year,
                "jucoP_era":  era,  "jucoP_whip": whip, "jucoP_ip": ip,
                "jucoP_k9":   so9 or None, "jucoP_bb9": bb9 or None,
                "jucoP_sv":   sv  or None, "jucoP_gs":  gs  or None,
                "proj_era":   proj_era, "proj_floor": proj_floor, "proj_ceil": proj_ceil,
                "gemScore": gem, "riskScore": 100 - gem,
                "isPitcher":  "true", "status": "available",
                "bats":       info.get("bats")     or "R",
                "throws":     info.get("throws")   or "R",
                "hometown":   info.get("hometown") or "",
                "ht":         info.get("ht")       or "",
                "wt":         info.get("wt")       or "",
                "age":        20,
            })

    print(f"  Parsed: {len(hitters)} hitters, {len(pitchers)} pitchers")
    return hitters, pitchers


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Scrape TBC school stats and push to SheetDB")
    ap.add_argument("--year",    type=int, default=2024,     help="Season year (default: 2024)")
    ap.add_argument("--schools", type=int, nargs="+",        help="School IDs to scrape (default: all in schools.json)")
    ap.add_argument("--dry-run", action="store_true",        help="Parse only — do not push to SheetDB")
    args = ap.parse_args()

    with open("schools.json") as f:
        schools_data = json.load(f)

    if args.schools:
        schools_data = {k: v for k, v in schools_data.items() if int(k) in args.schools}

    if not schools_data:
        print("No matching schools found in schools.json.")
        return

    print(f"Scraping {len(schools_data)} school(s) for {args.year}")
    print(f"Dry run: {args.dry_run}\n")

    print("Ensuring tbcId column exists in Players sheet…")
    ensure_tbcid_column()

    print("Fetching existing players from SheetDB…")
    existing_names, max_id = get_existing_players()
    print(f"  {len(existing_names)} players in DB (max ID {max_id})")

    total_found  = 0
    total_dupes  = 0
    total_pushed = 0
    next_id = max_id + 1

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        for school_id_str, info in schools_data.items():
            school_id   = int(school_id_str)
            school_name = info["name"]
            conf        = info["conf"]

            print(f"\n{'─'*50}")
            print(f"{school_name}  |  ID {school_id}  |  {conf}")

            try:
                hitters, pitchers = scrape_school(page, school_id, args.year, school_name, conf)
            except Exception as e:
                print(f"  Error: {e}")
                continue

            found = hitters + pitchers
            total_found += len(found)
            print(f"  Found:  {len(hitters)} hitters, {len(pitchers)} pitchers")

            new_players = []
            for p in found:
                key = p["name"].lower().strip()
                if key in existing_names:
                    total_dupes += 1
                else:
                    p["id"] = next_id
                    next_id += 1
                    existing_names.add(key)
                    new_players.append(p)

            dupes = len(found) - len(new_players)
            print(f"  Dupes:  {dupes}")
            print(f"  New:    {len(new_players)}")

            if args.dry_run:
                for p in new_players:
                    stat = (f"OPS {p['juco_ops']:.3f}  proj {p['proj_ops']:.3f}"
                            if p["isPitcher"] == "false"
                            else f"ERA {p['jucoP_era']:.2f}  proj {p['proj_era']:.2f}")
                    print(f"    [{p['pos']}] {p['name']:<30} {stat}  gem {p['gemScore']}")
            elif new_players:
                pushed = push_players(new_players)
                total_pushed += pushed
                print(f"  Pushed: {pushed}")

            time.sleep(random.uniform(2, 3))

        browser.close()

    print(f"\n{'═'*50}")
    print(f"  Total found:      {total_found}")
    print(f"  Duplicates:       {total_dupes}")
    print(f"  Pushed to sheet:  {total_pushed if not args.dry_run else '(dry run)'}")
    print(f"{'═'*50}")


if __name__ == "__main__":
    main()
