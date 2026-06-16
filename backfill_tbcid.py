"""
backfill_tbcid.py — Match players in Google Sheets to TBC player IDs.

For each school, fetches the TBC stats page, extracts player names + TBC IDs
from the batting/pitching table links, then writes tbcId back to any matched
rows in the Players sheet that are currently missing it.

Name matching uses: exact lowercase name, then school-qualified match.

Usage:
  python backfill_tbcid.py --schools 20349 --dry-run   # test one school
  python backfill_tbcid.py --dry-run                   # all schools, preview only
  python backfill_tbcid.py                             # full write run
  python backfill_tbcid.py --year 2025                 # different season year
"""

import argparse
import json
import time
import re
import gspread
from google.oauth2.service_account import Credentials
from playwright.sync_api import sync_playwright

SHEET_ID = "1j11FxEEADuAvFy5pJKVsQAfJKPGO6TRTxJT6gHnDRFI"
TBC_BASE = "https://www.thebaseballcube.com"
SCOPES   = ["https://www.googleapis.com/auth/spreadsheets"]


# ── Sheet helpers ─────────────────────────────────────────────────────────────

def load_sheet_players():
    """Return (worksheet, headers, list of row dicts with sheet_row index)."""
    creds = Credentials.from_service_account_file("Credentials.json", scopes=SCOPES)
    gc    = gspread.authorize(creds)
    ws    = gc.open_by_key(SHEET_ID).worksheet("Players")
    all_v = ws.get_all_values()
    headers = all_v[0]
    players = []
    for i, row in enumerate(all_v[1:], start=2):   # sheet_row is 1-indexed, row 1 = header
        def g(col_name):
            idx = headers.index(col_name) if col_name in headers else -1
            return row[idx].strip() if idx >= 0 and idx < len(row) else ""
        players.append({
            "sheet_row": i,
            "name":      g("name"),
            "school":    g("school"),
            "pos":       g("pos"),
            "tbc_id":    g("tbcId"),
        })
    return ws, headers, players


def build_lookup(players):
    """
    Build two lookup dicts for fast matching:
      exact[lower_name]              → list of player dicts
      school[(lower_name, lower_school)] → player dict
    """
    exact  = {}
    school = {}
    for p in players:
        if p["tbc_id"]:          # already has tbcId — skip
            continue
        key = p["name"].lower()
        exact.setdefault(key, []).append(p)
        skey = (key, p["school"].lower())
        school[skey] = p
    return exact, school


# ── TBC page extraction ───────────────────────────────────────────────────────

EXTRACT_JS = r"""() => {
    const result = [];
    const tables = document.querySelectorAll('table');
    for (const t of tables) {
        const rows = Array.from(t.querySelectorAll('tr'));
        if (!rows.length) continue;

        // Determine if this is a batting or pitching table by header cells
        const headerCells = Array.from(rows[0].querySelectorAll('td, th'))
                                 .map(c => c.textContent.trim().toLowerCase());
        const isBatting  = headerCells.includes('avg') && headerCells.includes('obp');
        const isPitching = headerCells.includes('era') && headerCells.includes('whip');
        if (!isBatting && !isPitching) continue;

        for (const row of rows.slice(1)) {
            const link = row.querySelector('a[href*="/content/player/"]');
            if (!link) continue;
            const m = link.href.match(/\/content\/player\/(\d+)\//);
            if (!m) continue;
            const name = link.textContent.replace('*', '').trim();
            if (!name || name.toLowerCase() === 'total') continue;
            result.push({ name, tbcId: m[1], type: isBatting ? 'hitter' : 'pitcher' });
        }
    }
    return result;
}"""


def fetch_tbc_players(page, school_id, year):
    url = f"{TBC_BASE}/content/stats_college/{year}~{school_id}/"
    page.goto(url, wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(5000)
    return page.evaluate(EXTRACT_JS)


# ── Matching logic ────────────────────────────────────────────────────────────

def find_match(tbc_player, tbc_school_name, exact_lookup, school_lookup):
    """Return matched sheet player or None. Prefers school-qualified match."""
    name_key   = tbc_player["name"].lower()
    school_key = (name_key, tbc_school_name.lower())

    # 1. School-qualified exact match (most reliable)
    if school_key in school_lookup:
        return school_lookup[school_key]

    # 2. Name-only match, but only if unambiguous (exactly one row with that name)
    candidates = exact_lookup.get(name_key, [])
    if len(candidates) == 1:
        return candidates[0]

    # 3. Ambiguous (same name, multiple schools) — skip to avoid wrong assignment
    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Backfill tbcId for players in Google Sheets")
    ap.add_argument("--schools",  type=int, nargs="+", help="School IDs to process (default: all in schools.json)")
    ap.add_argument("--year",     type=int, default=2026, help="TBC stats year to fetch (default: 2026)")
    ap.add_argument("--dry-run",  action="store_true",   help="Preview matches without writing to sheet")
    args = ap.parse_args()

    # ── Build school list ──────────────────────────────────────────────────────
    if args.schools:
        # No schools.json needed when school IDs are given explicitly
        schools_map = {str(sid): {"name": f"School {sid}"} for sid in args.schools}
    else:
        try:
            with open("schools.json") as f:
                schools_map = json.load(f)
        except FileNotFoundError:
            print("ERROR: schools.json not found. Use --schools to specify school IDs directly.")
            return

    print(f"Schools to process: {len(schools_map)}")
    print(f"Year: {args.year}   Dry run: {args.dry_run}\n")

    # ── Load sheet ─────────────────────────────────────────────────────────────
    print("Loading Players sheet…")
    ws, headers, players = load_sheet_players()
    tbc_col_idx = headers.index("tbcId") + 1  # gspread uses 1-indexed columns

    # Pre-compute the column letter for batch_update range strings (e.g. 60 -> "BH")
    def col_letter(n):
        s = ""
        while n > 0:
            n, r = divmod(n - 1, 26)
            s = chr(65 + r) + s
        return s
    tbc_col_letter = col_letter(tbc_col_idx)

    missing = [p for p in players if not p["tbc_id"]]
    print(f"  Total players: {len(players)}")
    print(f"  Missing tbcId: {len(missing)}\n")

    exact_lookup, school_lookup = build_lookup(players)

    # ── Playwright session ─────────────────────────────────────────────────────
    total_matched = 0
    total_written = 0
    total_ambig   = 0
    total_no_match = 0

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

        for school_id_str, info in schools_map.items():
            school_id   = int(school_id_str)
            school_name = info.get("name", f"School {school_id}")
            print(f"{'-'*50}")
            print(f"{school_name}  (ID {school_id})")

            try:
                tbc_players = fetch_tbc_players(page, school_id, args.year)
            except Exception as e:
                print(f"  Error fetching page: {e}")
                time.sleep(2)
                continue

            if not tbc_players:
                print(f"  No players found on page (may be wrong year or school has no data)")
                time.sleep(2)
                continue

            print(f"  Found {len(tbc_players)} players on TBC page")

            school_matched  = 0
            school_written  = 0
            school_no_match = 0
            batch_updates   = []   # collected before a single API call

            for tp in tbc_players:
                match = find_match(tp, school_name, exact_lookup, school_lookup)

                if match is None:
                    cands = exact_lookup.get(tp["name"].lower(), [])
                    if len(cands) > 1:
                        print(f"  AMBIG   {tp['name']:30s}  tbcId={tp['tbcId']}  ({len(cands)} rows with this name)")
                        total_ambig += 1
                    else:
                        school_no_match += 1
                        total_no_match  += 1
                    continue

                school_matched += 1
                total_matched  += 1
                tag = "[DRY RUN] " if args.dry_run else ""
                print(f"  {tag}Matched: {tp['name']:30s}  tbcId={tp['tbcId']}  (row {match['sheet_row']})")

                if not args.dry_run:
                    batch_updates.append({
                        "range":  f"{tbc_col_letter}{match['sheet_row']}",
                        "values": [[tp["tbcId"]]],
                    })
                    # Remove from lookup to prevent duplicate assignment
                    exact_lookup.get(tp["name"].lower(), []).remove(match)
                    skey = (tp["name"].lower(), match["school"].lower())
                    school_lookup.pop(skey, None)

            # One batch write per school — stays well under the 60 writes/min quota
            if batch_updates and not args.dry_run:
                ws.batch_update(batch_updates)
                school_written = len(batch_updates)
                total_written += school_written

            print(f"  Matched: {school_matched}  Written: {school_written}  No match: {school_no_match}")
            time.sleep(2)

        browser.close()

    print(f"\n{'='*50}")
    print(f"  Total matched:   {total_matched}")
    print(f"  Total written:   {total_written}  {'(dry run - nothing written)' if args.dry_run else ''}")
    print(f"  Ambiguous:       {total_ambig}")
    print(f"  No match:        {total_no_match}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
