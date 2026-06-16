"""Print a count of players per position from the Players sheet, sorted descending."""

from collections import Counter
import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "1j11FxEEADuAvFy5pJKVsQAfJKPGO6TRTxJT6gHnDRFI"
SCOPES   = ["https://www.googleapis.com/auth/spreadsheets"]


def get_worksheet():
    creds = Credentials.from_service_account_file("Credentials.json", scopes=SCOPES)
    gc    = gspread.authorize(creds)
    return gc.open_by_key(SHEET_ID).worksheet("Players")


def main():
    print("Loading Players sheet...")
    ws         = get_worksheet()
    all_values = ws.get_all_values()
    headers    = all_values[0]
    pos_col    = headers.index("pos") if "pos" in headers else -1

    if pos_col < 0:
        print("ERROR: 'pos' column not found.")
        return

    counts = Counter()
    for row in all_values[1:]:
        pos = row[pos_col].strip() if pos_col < len(row) else ""
        counts[pos or "(blank)"] += 1

    print(f"\n{'Position':<12}{'Count'}")
    print("-" * 20)
    for pos, n in counts.most_common():
        print(f"{pos:<12}{n}")


if __name__ == "__main__":
    main()
