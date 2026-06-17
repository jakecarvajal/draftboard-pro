"""
update_player.py  —  Update a player's status/dest/notes in the Google Sheet.

Uses gspread with a service-account credentials.json for write access.

Examples:
  python update_player.py --name "Cade Climie" --status committed --dest "Texas A&M"
  python update_player.py --name "Lucas Davenport" --notes "elite arm, Big 12 ready"
"""

import argparse
import sys

import gspread
from google.oauth2.service_account import Credentials

SHEET_ID   = "1j11FxEEADuAvFy5pJKVsQAfJKPGO6TRTxJT6gHnDRFI"
CREDS_FILE = "credentials.json"
SCOPES     = ["https://www.googleapis.com/auth/spreadsheets"]

VALID_STATUSES = {"committed", "available", "signed", "drafted"}

# Maps CLI arg name -> sheet column header
FIELD_MAP = {
    "status": "status",
    "dest":   "dest",
    "notes":  "notes",
}


def open_sheet():
    creds = Credentials.from_service_account_file(CREDS_FILE, scopes=SCOPES)
    gc    = gspread.authorize(creds)
    return gc.open_by_key(SHEET_ID).worksheet("Players")


def find_players(rows, name_query):
    q = name_query.strip().lower()
    return [
        (i + 2, row)                          # i+2 = 1-based sheet row (row 1 is header)
        for i, row in enumerate(rows)
        if q in str(row.get("name", "")).lower()
    ]


def pick_player(matches):
    if len(matches) == 1:
        return matches[0]

    print(f"\n{len(matches)} players matched:\n")
    for idx, (sheet_row, row) in enumerate(matches, 1):
        print(f"  {idx}.  [{row.get('id','?'):>5}]  {row.get('name','?'):<30}  "
              f"{row.get('school','?'):<22}  status={row.get('status','?')}")
    print()

    while True:
        raw = input("Pick a number (or q to quit): ").strip()
        if raw.lower() == "q":
            print("Aborted.")
            sys.exit(0)
        if raw.isdigit() and 1 <= int(raw) <= len(matches):
            return matches[int(raw) - 1]
        print(f"  Enter a number between 1 and {len(matches)}.")


def show_diff(row, updates):
    col_w = max(len(k) for k in updates) + 2
    print()
    print(f"  {'Field':<{col_w}}  {'Current':<30}  {'New'}")
    print(f"  {'-'*col_w}  {'-'*30}  {'-'*30}")
    for field, new_val in updates.items():
        current = str(row.get(field) or "")
        marker  = "  " if current == new_val else "->"
        print(f"  {field:<{col_w}}  {current:<30}  {marker} {new_val}")
    print()


def main():
    ap = argparse.ArgumentParser(description="Update a player row in the DraftBoard Players sheet")
    ap.add_argument("--name",   required=True, help="Player name to search (partial, case-insensitive)")
    ap.add_argument("--status", choices=sorted(VALID_STATUSES), help="Recruitment status")
    ap.add_argument("--dest",   help="Destination school")
    ap.add_argument("--notes",  help="Scouting notes")
    args = ap.parse_args()

    updates = {
        field: getattr(args, field)
        for field in FIELD_MAP
        if getattr(args, field) is not None
    }

    if not updates:
        ap.error("Provide at least one of --status, --dest, or --notes.")

    print("Connecting to Google Sheets…")
    try:
        ws = open_sheet()
    except Exception as e:
        print(f"ERROR: could not open sheet — {e}", file=sys.stderr)
        sys.exit(1)

    print("Reading all rows…")
    rows = ws.get_all_records(numericise_ignore=["all"])

    matches = find_players(rows, args.name)
    if not matches:
        print(f"No players found matching '{args.name}'.")
        sys.exit(1)

    sheet_row, row = pick_player(matches)

    print(f"\nSelected: [{row.get('id','?')}] {row.get('name','?')}  "
          f"({row.get('school','?')})")

    show_diff(row, updates)

    answer = input("Apply these changes? (y/N): ").strip().lower()
    if answer != "y":
        print("Aborted.")
        sys.exit(0)

    # Resolve column indices once so we can do targeted cell updates
    headers = ws.row_values(1)
    for field, new_val in updates.items():
        col_name = FIELD_MAP[field]
        try:
            col_idx = headers.index(col_name) + 1   # 1-based
        except ValueError:
            print(f"WARNING: column '{col_name}' not found in sheet header — skipping.")
            continue
        ws.update_cell(sheet_row, col_idx, new_val)

    print(f"\nDone. {row.get('name','?')} updated ({', '.join(f'{k}={v}' for k, v in updates.items())}).")


if __name__ == "__main__":
    main()
