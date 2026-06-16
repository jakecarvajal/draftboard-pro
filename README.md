# DraftBoard Pro

DraftBoard Pro is a set of tools for building and maintaining a junior-college
baseball draft board. It scrapes player rosters and stats from
[TheBaseballCube](https://www.thebaseballcube.com), backfills missing player
data (position, bats/throws, hometown, height/weight), and keeps a Google
Sheet ("Players" tab) as the source of truth that powers the admin/draft
board front end (`index.html`, `DraftBoard_Admin.html`).

## Setup

1. Install Python 3.12+ and the required dependencies:

   ```
   pip install gspread google-auth playwright requests
   playwright install chromium
   ```

2. Add a Google service account credentials file named `credentials.json` to
   the project root. This file grants write access to the Google Sheet and
   is **never committed to the repo** (see `.gitignore`). Share the target
   Google Sheet with the service account's email address so it has edit
   access.

## Running the scraper

`scraper.py` pulls school/year roster and stats data from TBC and writes new
player rows into the Players sheet.

```
python scraper.py --year 2024 --schools 20349 --dry-run   # preview one school
python scraper.py --year 2024 --schools 20349             # write one school
python scraper.py --year 2024                              # all schools, write
python scraper.py --year 2024 --dry-run                     # all schools, preview
```

## Running get_positions.py

`get_positions.py` fills in missing `pos`, `bats`, `throws`, `hometown`,
`ht`, and `wt` fields for players whose position is blank, `UTIL`, or a raw
TBC code that still needs mapping. It fetches each school's roster page once
and matches players by name.

```
python get_positions.py              # process all eligible schools
python get_positions.py --limit 5    # test on the first 5 schools
python get_positions.py --dry-run    # preview without writing
```

## Running cleanup_players.py

`cleanup_players.py` deletes synthetic-wave players (rows with `id < 1547`)
from the Players sheet, keeping a small allowlist of named exceptions.

```
python cleanup_players.py            # delete synthetic players
python cleanup_players.py --dry-run  # preview deletions without writing
```

## Other scripts

- `find_school_ids.py` — discovers TBC school IDs for schools in the Players
  sheet and saves them to `schools.json`.
- `backfill_tbcid.py` — matches players to their TBC player IDs and writes
  `tbcId` back to the sheet.
- `check_players.py` — audits the Players sheet (synthetic vs. real player
  counts, name-quality checks).
- `position_breakdown.py` — prints a count of players per position from the
  Players sheet.
