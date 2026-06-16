"""
get_positions.py — Fill in pos/bats/throws/hometown for UTIL/blank players.

The TBC player profile page shows no bio for "Player Not Tracked" players.
Instead this script fetches each school's stats page (which has a roster table
with pos/bats/throws/hometown), then matches players by name.

One page fetch per (school, year) combination — much more efficient than one
per player.

Usage:
  python get_positions.py              # all eligible schools
  python get_positions.py --limit 5   # test on first 5 schools
  python get_positions.py --dry-run   # preview without writing
"""

import argparse
import json
import time
from collections import defaultdict
import gspread
from google.oauth2.service_account import Credentials
from playwright.sync_api import sync_playwright

SHEET_ID = "1j11FxEEADuAvFy5pJKVsQAfJKPGO6TRTxJT6gHnDRFI"
TBC_BASE = "https://www.thebaseballcube.com"
SCOPES   = ["https://www.googleapis.com/auth/spreadsheets"]

ROSTER_JS = r"""() => {
    // Find the roster table: has both 'pos' and 'ht' headers
    const tables = document.querySelectorAll('table');
    for (const t of tables) {
        const rows = Array.from(t.querySelectorAll('tr'));
        if (!rows.length) continue;
        const headers = Array.from(rows[0].querySelectorAll('td,th'))
                            .map(c => c.textContent.trim().toLowerCase());
        if (!headers.includes('pos') || !headers.includes('ht')) continue;

        const col = name => headers.indexOf(name);
        const roster = [];
        for (const row of rows.slice(1)) {
            const cells = Array.from(row.querySelectorAll('td,th'))
                              .map(c => c.textContent.trim());
            const get = name => col(name) >= 0 && col(name) < cells.length
                                ? cells[col(name)] : '';
            const name = get('player').replace('*','').trim();
            if (!name || name.toLowerCase() === 'total') continue;
            roster.push({
                name,
                pos:      get('pos'),
                ht:       get('ht'),
                wt:       get('wt'),
                bats:     get('ba') || get('bat') || get('bats') || '',
                throws:   get('th') || get('thr') || get('throws') || '',
                hometown: get('place') || get('hometown') || get('city') || '',
            });
        }
        if (roster.length) return roster;
    }
    return [];
}"""


# Raw TBC codes that need remapping — these are eligible for re-processing
# even if the player already has a non-UTIL position written.
NEEDS_MAPPING = {
    "IF", "OF", "UT", "P", "RHP", "LHP",
    "OF-P", "P-OF", "IF-P", "P-IF", "P-1B", "P-C", "P-2B", "P-UT", "P-DH",
    "C-OF", "OF-1B", "OF-C", "1B-P", "3B-P", "2B-P",
    # Compound codes found in the sheet that still need remapping
    "IF-OF", "2B-SS", "C-IF", "1B-OF", "OF-IF", "SS-OF", "1B-3B", "3B-SS",
    "C-OF", "UT-P", "2B-OF", "C-UT", "C-1B", "1B-DH", "OF-DH", "C-3B",
    "3B-OF", "C-P", "SS-2B", "OF-2B", "3B-2B", "SS-3B",
}

_POS_MAP = {
    "C": "C", "1B": "1B", "2B": "2B", "3B": "3B",
    "SS": "SS", "LF": "LF", "CF": "CF", "RF": "RF", "DH": "DH",
    "OF": "CF",    # generic outfielder → CF
    "IF": "2B",    # generic infielder → 2B
    "UT": "UTIL", "UTIL": "UTIL",
}

# Explicit overrides for specific compound codes (checked before the
# generic primary-token fallback below).
COMPOUND_MAP = {
    "IF-OF": "2B",
    "2B-SS": "SS",
    "C-IF":  "C",
    "1B-OF": "1B",
    "OF-IF": "CF",
    "SS-OF": "SS",
    "1B-3B": "1B",
    "3B-SS": "3B",
    "OF-1B": "CF",
    "C-OF":  "C",
}


def map_position(tbc_pos, jucoP_era=None, jucoP_gs=None, jucoP_sv=None):
    """Map a raw TBC position code to our standard position vocabulary."""
    p = (tbc_pos or "").strip().upper()

    if p in _POS_MAP:
        return _POS_MAP[p]

    if p in COMPOUND_MAP:
        return COMPOUND_MAP[p]

    # Pitcher codes: SP vs RP decided by save count vs start count
    if p in ("P", "SP", "RP", "RHP", "LHP"):
        sv = float(jucoP_sv or 0)
        gs = float(jucoP_gs or 0)
        era = float(jucoP_era or 0)
        if era == 0:
            return "SP"       # no pitching stats — default to SP
        return "RP" if sv > 3 else ("RP" if gs <= 3 and sv > 0 else "SP")

    # Any other compound code — use the primary (first) token
    primary = p.split("-")[0].split("/")[0]
    if primary == "IF":
        return "2B"
    if primary == "OF":
        return "CF"
    if primary in ("P", "RHP", "LHP"):
        return "SP"
    if primary in _POS_MAP:
        return _POS_MAP[primary]

    return "UTIL"


def get_worksheet():
    creds = Credentials.from_service_account_file("Credentials.json", scopes=SCOPES)
    gc    = gspread.authorize(creds)
    return gc.open_by_key(SHEET_ID).worksheet("Players")


def col_letter(n):
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit",   type=int, default=None,  help="Process only first N schools")
    ap.add_argument("--dry-run", action="store_true",     help="Preview without writing")
    args = ap.parse_args()

    # Load schools.json for school_name -> school_id lookup
    try:
        with open("schools.json") as f:
            schools_json = json.load(f)
        school_id_map = {info["name"]: sid for sid, info in schools_json.items()}
    except FileNotFoundError:
        print("ERROR: schools.json not found. Run find_school_ids.py first.")
        return

    print("Loading Players sheet...")
    ws         = get_worksheet()
    all_values = ws.get_all_values()
    headers    = all_values[0]

    def col(name): return headers.index(name) if name in headers else -1
    name_col      = col("name")
    school_col    = col("school")
    year_col      = col("year")
    pos_col       = col("pos")
    bats_col      = col("bats")
    throws_col    = col("throws")
    hometown_col  = col("hometown")
    ht_col        = col("ht")
    wt_col        = col("wt")
    tbc_col       = col("tbcId")
    jucoP_era_col = col("jucoP_era")
    jucoP_gs_col  = col("jucoP_gs")
    jucoP_sv_col  = col("jucoP_sv")

    # Column letters for batch_update
    col_map = {
        "pos":      col_letter(pos_col + 1)      if pos_col >= 0 else None,
        "bats":     col_letter(bats_col + 1)     if bats_col >= 0 else None,
        "throws":   col_letter(throws_col + 1)   if throws_col >= 0 else None,
        "hometown": col_letter(hometown_col + 1) if hometown_col >= 0 else None,
        "ht":       col_letter(ht_col + 1)       if ht_col >= 0 else None,
        "wt":       col_letter(wt_col + 1)       if wt_col >= 0 else None,
    }

    # Group eligible rows by (school, year)
    # Eligible: pos is UTIL, blank, or a raw TBC code that still needs mapping
    school_year_groups = defaultdict(list)
    for i, row in enumerate(all_values[1:], start=2):
        def g(c): return row[c].strip() if c >= 0 and c < len(row) else ""
        pos    = g(pos_col)
        school = g(school_col)
        year   = g(year_col)
        name   = g(name_col)
        if pos and pos not in ("UTIL", "") and pos not in NEEDS_MAPPING:
            continue
        if not school or not name:
            continue
        if school not in school_id_map:
            continue
        school_year_groups[(school, year)].append({
            "sheet_row":  i,
            "name":       name,
            "old_pos":    pos,
            "has_tbc":    bool(g(tbc_col)),
            "jucoP_era":  g(jucoP_era_col),
            "jucoP_gs":   g(jucoP_gs_col),
            "jucoP_sv":   g(jucoP_sv_col),
        })

    groups = list(school_year_groups.items())
    total_eligible = sum(len(v) for v in school_year_groups.values())
    print(f"  Eligible players : {total_eligible}")
    print(f"  School/year pairs: {len(groups)}")

    if args.limit:
        groups = groups[:args.limit]
        print(f"  Limited to first {args.limit} school/year pairs\n")

    total_updated = 0
    total_no_match = 0
    total_schools  = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

        for (school, year), players in groups:
            school_id = school_id_map.get(school)
            if not school_id:
                print(f"  SKIP {school} — no school ID")
                continue

            url = f"{TBC_BASE}/content/stats_college/{year}~{school_id}/"
            print(f"\n{school} ({year})  ID={school_id}  [{len(players)} to update]")

            try:
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                page.wait_for_timeout(5000)
                roster = page.evaluate(ROSTER_JS)
            except Exception as e:
                print(f"  ERROR fetching page: {e}")
                time.sleep(2)
                continue

            if not roster:
                print(f"  No roster table found on page")
                time.sleep(2)
                continue

            print(f"  Roster table: {len(roster)} entries")

            # Build name lookup from roster (lowercase)
            roster_map = {r["name"].lower(): r for r in roster}

            batch = []
            school_updated  = 0
            school_no_match = 0

            for p in players:
                info = roster_map.get(p["name"].lower())
                if not info:
                    school_no_match += 1
                    total_no_match  += 1
                    continue

                changes = []
                row = p["sheet_row"]

                if info.get("pos") and pos_col >= 0:
                    mapped = map_position(
                        info["pos"],
                        jucoP_era=p.get("jucoP_era"),
                        jucoP_gs=p.get("jucoP_gs"),
                        jucoP_sv=p.get("jucoP_sv"),
                    )
                    batch.append({"range": f"{col_map['pos']}{row}", "values": [[mapped]]})
                    changes.append(f"pos: {p['old_pos'] or '(blank)'} -> {info['pos']} -> {mapped}")

                if info.get("bats") and bats_col >= 0:
                    batch.append({"range": f"{col_map['bats']}{row}", "values": [[info["bats"]]]})
                    changes.append(f"bats={info['bats']}")

                if info.get("throws") and throws_col >= 0:
                    batch.append({"range": f"{col_map['throws']}{row}", "values": [[info["throws"]]]})
                    changes.append(f"throws={info['throws']}")

                if info.get("hometown") and hometown_col >= 0:
                    batch.append({"range": f"{col_map['hometown']}{row}", "values": [[info["hometown"]]]})
                    changes.append(f"hometown={info['hometown']}")

                if info.get("ht") and ht_col >= 0:
                    batch.append({"range": f"{col_map['ht']}{row}", "values": [[info["ht"]]]})
                    changes.append(f"ht={info['ht']}")

                wt_val = info.get("wt", "")
                if wt_val and str(wt_val) != "0" and wt_col >= 0:
                    batch.append({"range": f"{col_map['wt']}{row}", "values": [[wt_val]]})
                    changes.append(f"wt={wt_val}")

                if changes:
                    tag = "[DRY] " if args.dry_run else ""
                    print(f"  {tag}{p['name']:30s}  {', '.join(changes)}")
                    school_updated += 1

            if batch and not args.dry_run:
                ws.batch_update(batch)

            total_updated  += school_updated
            total_no_match += 0   # already counted above
            total_schools  += 1
            print(f"  Updated: {school_updated}  No match: {school_no_match}")
            time.sleep(2)

        browser.close()

    print(f"\n{'='*60}")
    print(f"  Schools processed : {total_schools}")
    print(f"  Players updated   : {total_updated}  {'(dry run)' if args.dry_run else ''}")
    print(f"  No roster match   : {total_no_match}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
