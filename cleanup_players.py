"""
cleanup_players.py  —  Delete synthetic-wave players from the Players sheet.

Deletes every row where id < 1547, EXCEPT for the three keepers below.
Uses gspread with a service-account credentials.json for write access.

Run:
  python cleanup_players.py
  python cleanup_players.py --dry-run   # show what would be deleted, no writes
"""

import argparse
import sys
import time

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID   = "1j11FxEEADuAvFy5pJKVsQAfJKPGO6TRTxJT6gHnDRFI"
CREDS_FILE = "credentials.json"
SCOPES     = ["https://www.googleapis.com/auth/spreadsheets"]

SYNTHETIC_ID_CUTOFF = 1547

KEEP_NAMES = {
    "easton rulli",
    "aidan lombardi",
    "bryce campbell",
}


def open_sheet():
    creds = Credentials.from_service_account_file(CREDS_FILE, scopes=SCOPES)
    gc    = gspread.authorize(creds)
    return gc.open_by_key(SHEET_ID).worksheet("Players")


def main():
    ap = argparse.ArgumentParser(description="Delete synthetic players (id < 1547) from the sheet")
    ap.add_argument("--dry-run", action="store_true", help="Preview deletions without writing")
    args = ap.parse_args()

    print("Connecting to Google Sheets…")
    try:
        ws = open_sheet()
    except Exception as e:
        print(f"ERROR: could not open sheet — {e}", file=sys.stderr)
        sys.exit(1)

    print("Reading all rows…")
    rows = ws.get_all_records(numericise_ignore=["all"])  # keep everything as strings

    # Identify rows to delete (1-indexed in the sheet; row 1 is the header)
    to_delete = []   # list of (sheet_row_number, id, name)
    kept       = []

    for i, row in enumerate(rows, start=2):  # row 2 = first data row
        raw_id   = row.get("id", "")
        name_key = str(row.get("name", "")).strip().lower()
        try:
            pid = int(float(raw_id))
        except (ValueError, TypeError):
            continue

        if pid >= SYNTHETIC_ID_CUTOFF:
            continue
        if name_key in KEEP_NAMES:
            kept.append((pid, row.get("name", "")))
            continue

        to_delete.append((i, pid, row.get("name", "")))

    # ── Summary before confirmation ───────────────────────────────────────────
    print()
    print("=" * 60)
    print(f"  Players with id < {SYNTHETIC_ID_CUTOFF}   : {len(to_delete) + len(kept)}")
    print(f"  Kept (protected names)     : {len(kept)}")
    for pid, name in kept:
        print(f"    ✓ [{pid}] {name}")
    print(f"  To be deleted              : {len(to_delete)}")
    print("=" * 60)
    print()

    if not to_delete:
        print("Nothing to delete. Exiting.")
        return

    if args.dry_run:
        print("DRY RUN — first 20 rows that would be deleted:")
        for sheet_row, pid, name in to_delete[:20]:
            print(f"  sheet row {sheet_row:>4}  id {pid:>5}  {name}")
        if len(to_delete) > 20:
            print(f"  … and {len(to_delete) - 20} more")
        print("\n(no changes written)")
        return

    answer = input(f"Type YES to delete {len(to_delete)} rows: ").strip()
    if answer != "YES":
        print("Aborted.")
        return

    print()
    print("Deleting rows (working from bottom up to preserve row numbers)…")

    # Sort descending by sheet row so deleting one row doesn't shift the next
    to_delete.sort(key=lambda x: x[0], reverse=True)

    deleted = 0
    for sheet_row, pid, name in to_delete:
        ws.delete_rows(sheet_row)
        deleted += 1
        if deleted % 50 == 0:
            print(f"  … {deleted}/{len(to_delete)} deleted")
        # Avoid hitting the Sheets API rate limit (60 writes/min per project)
        time.sleep(1.1)

    print()
    print(f"Done. {deleted} rows deleted.")


if __name__ == "__main__":
    main()
