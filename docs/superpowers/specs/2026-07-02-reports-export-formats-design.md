# Reports Export: Format Options, Summary Columns, Per-Gathering Date Columns

**Date:** 2026-07-02
**Status:** Approved

## Problem

The Reports page export (`GET /api/reports/export`) is TSV-only, has no
per-person attendance totals, and mishandles multi-gathering selections:
sessions from all selected gatherings collapse into date-only columns, so two
gatherings meeting on the same date produce duplicate, ambiguous columns whose
cells ignore which gathering the person attended.

## Goals

1. Let the user choose an export format — CSV, Excel (.xlsx), or TSV — and
   remember the last-selected format as the default.
2. Add `Present Count` and `Absent Count` columns immediately before the date
   columns.
3. Single-gathering exports carry no gathering name in the data (it is already
   in the filename). Multi-gathering exports disambiguate by putting the
   gathering name in each date column header.

## Non-Goals

- No change to who can export (admin/coordinator) or to the row population
  (people with at least one attendance record in range).
- No long/tidy-format export; the wide person-per-row layout stays.
- No automated server tests (server has no test runner); verification is
  manual.

## Design

### Server

`GET /api/reports/export` gains a `format` query param: `csv` | `tsv` |
`xlsx`. Missing/unrecognized values fall back to `tsv` (back-compat).

Row building moves out of `server/routes/reports.js` into a pure module
`server/utils/attendanceExport.js`:

- `buildExportTable({ sessions, people, attendanceMap })` →
  `{ headers: string[], rows: (string|number)[][] }`
- `toCsv(table)`, `toTsv(table)` → string; `toXlsx(table)` → Buffer
  (via new dependency `exceljs`).

**Columns:** `First Name, Last Name, Family Name, People Type, Adult/Child,
Present Count, Absent Count, <date columns...>`.

- `Present Count` = number of date columns in which the person is marked
  present; `Absent Count` = number marked absent. The two sum to the number of
  date columns (unrecorded = absent, matching today's TRUE/FALSE cell
  semantics).

**Date columns:** one column per distinct *(session_date, gathering)* pair,
ordered by date then gathering name.

- Multiple gatherings selected → header `YYYY-MM-DD – <Gathering Name>`.
- Single gathering → header `YYYY-MM-DD`; no gathering name anywhere in the
  data.
- The attendance lookup key becomes
  `individual_id + session_date + gathering_type_id` (the attendance query
  gains `gathering_type_id` via the session join), fixing the duplicate-column
  bug.

**Serialization:**

- CSV: comma separator, RFC-4180 quoting (wrap fields containing `,`, `"`, or
  newline in double quotes; double embedded quotes) — same rule as the
  existing client-side `csvEscape` in `client/src/utils/attendanceHistoryCsv.ts`.
  No pipe or other exotic separators.
- TSV: as today, but replace tabs/newlines inside field values with spaces.
- XLSX: single worksheet, bold frozen header row, counts as numbers.
- Content-Type per format: `text/csv`, `text/tab-separated-values`,
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

`exceljs` is a new server dependency → rebuild the server container
(`docker-compose -f docker-compose.dev.yml build server`).

### Client (`client/src/pages/ReportsPage.tsx`)

- Replace the single Export button with a split button: the main button
  exports in the last-used format (label e.g. "Export CSV"); a chevron opens a
  dropdown listing CSV / Excel (.xlsx) / TSV.
- Persist the selection in `localStorage` under `reports.exportFormat`; read
  on mount; first-ever default is `csv`. Selecting a format from the dropdown
  triggers the export and becomes the new default.
- `reportsAPI.exportData` passes `format`; the download keeps
  `responseType: 'blob'`.
- Filename: `attendance-report-{gathering-names}-{start}-to-{end}.{ext}` with
  the matching Blob MIME type.

### Error handling

Unchanged route-level behavior: failures return 500 JSON and the client
surfaces the message. XLSX generation errors flow through the same catch.

## Verification (manual)

After rebuilding the server container: export each of the three formats for
(a) a single gathering and (b) two gatherings spanning a shared date. Confirm
in a spreadsheet app: counts columns sit before date columns and sum to the
date-column total; multi-gathering headers show `date – gathering`;
single-gathering export has no gathering column; CSV fields containing commas
(e.g. family names like "Smith, John and Jane") survive round-trip; TSV still
opens as before; xlsx opens in Excel/Numbers.
