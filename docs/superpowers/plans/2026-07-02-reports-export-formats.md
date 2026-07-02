# Reports Export Formats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CSV/Excel/TSV format options to the Reports page export (remembering the last choice), add Present/Absent count columns before the date columns, and make multi-gathering exports unambiguous via per-gathering date column headers.

**Architecture:** Export generation stays server-side. Row/column building moves from the `/api/reports/export` route into a pure module `server/utils/attendanceExport.js` with per-format serializers (CSV with RFC-4180 quoting, TSV, XLSX via `exceljs`). The route gains a `format` query param (default `tsv`). The client replaces the Export button with a split button whose last-used format persists via the existing `userPreferences` service.

**Tech Stack:** Node/Express, `exceljs` (new server dep), React 19 + TypeScript, Tailwind. Spec: `docs/superpowers/specs/2026-07-02-reports-export-formats-design.md`.

**Important workflow rule:** Never run builds or type checks on the host. All builds, installs, and script runs happen through Docker (`docker-compose -f docker-compose.dev.yml ...`). The dev compose mounts `./server` into the server container, so edited server files and new scripts are visible inside it without a rebuild (nodemon auto-reloads); only dependency changes need a rebuild.

---

### Task 1: Add exceljs dependency

**Files:**
- Modify: `server/package.json` (dependencies)

- [ ] **Step 1: Add the dependency to package.json**

In `server/package.json`, add to `"dependencies"` (alphabetical order, after `"dotenv"`):

```json
    "exceljs": "^4.4.0",
```

- [ ] **Step 2: Rebuild and restart the server container (installs the dep)**

```bash
docker-compose -f docker-compose.dev.yml build server
docker-compose -f docker-compose.dev.yml up -d server
```

Expected: build succeeds; `npm install` layer shows exceljs being added.

- [ ] **Step 3: Verify exceljs loads inside the container**

```bash
docker-compose -f docker-compose.dev.yml exec server node -e "console.log(require('exceljs/package.json').version)"
```

Expected: prints a `4.x` version.

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/package-lock.json
git commit -m "chore(server): add exceljs for xlsx report exports"
```

(If `server/package-lock.json` didn't change on the host, commit just `package.json`.)

---

### Task 2: Pure export-table module + check script

**Files:**
- Create: `server/utils/attendanceExport.js`
- Create: `server/scripts/checkAttendanceExport.js` (assertion script — the server has no test runner, so this is the executable check)

- [ ] **Step 1: Write the check script (the "failing test")**

Create `server/scripts/checkAttendanceExport.js`:

```js
// Assertion checks for utils/attendanceExport.js.
// Run inside the server container: node scripts/checkAttendanceExport.js
const assert = require('assert');
const { buildExportTable, toCsv, toTsv, toXlsx } = require('../utils/attendanceExport');

const sessions = [
  { session_date: '2026-06-07', gathering_type_id: 1, gathering_name: 'Sunday AM' },
  { session_date: '2026-06-07', gathering_type_id: 2, gathering_name: 'Youth' },
  { session_date: '2026-06-14', gathering_type_id: 1, gathering_name: 'Sunday AM' },
];
const people = [
  { id: 5, first_name: 'Jo', last_name: 'Smith, Jr', family_name: 'Smith', people_type: 'Regular Attender', is_child: 0 },
  { id: 6, first_name: 'Amy', last_name: 'Quote"Name', family_name: '', people_type: 'Local Visitor', is_child: 1 },
];
const attendanceMap = new Map([
  ['5_2026-06-07_1', true],
  ['5_2026-06-14_1', true],
  ['6_2026-06-07_2', true],
]);

// Multi-gathering: gathering name in date headers, counts before date columns
const table = buildExportTable({ sessions, people, attendanceMap, includeGatheringInHeaders: true });
assert.deepStrictEqual(table.headers, [
  'First Name', 'Last Name', 'Family Name', 'People Type', 'Adult/Child',
  'Present Count', 'Absent Count',
  '2026-06-07 – Sunday AM', '2026-06-07 – Youth', '2026-06-14 – Sunday AM',
]);
assert.deepStrictEqual(table.rows[0], [
  'Jo', 'Smith, Jr', 'Smith', 'Regular Attender', 'Adult',
  2, 1, 'TRUE', 'FALSE', 'TRUE',
]);
assert.deepStrictEqual(table.rows[1].slice(4), ['Child', 1, 2, 'FALSE', 'TRUE', 'FALSE']);

// Single gathering: plain date headers, no gathering name anywhere
const single = buildExportTable({
  sessions: sessions.filter(s => s.gathering_type_id === 1),
  people,
  attendanceMap,
  includeGatheringInHeaders: false,
});
assert.deepStrictEqual(single.headers.slice(7), ['2026-06-07', '2026-06-14']);
assert.ok(!single.headers.some(h => h.includes('Sunday AM')));

// CSV: comma separator with RFC-4180 quoting
const csv = toCsv(table);
const csvLines = csv.split('\n');
assert.ok(csvLines[1].includes('"Smith, Jr"'), 'field with comma must be quoted');
assert.ok(csvLines[2].includes('"Quote""Name"'), 'embedded quotes must be doubled');
assert.strictEqual(csvLines[0].split(',').length, table.headers.length);

// TSV: tab separator, control characters sanitized
const tsv = toTsv(table);
tsv.split('\n').forEach(line => assert.strictEqual(line.split('\t').length, table.headers.length));

// XLSX: produces a non-empty buffer with the xlsx magic bytes (PK zip header)
toXlsx(table).then(buffer => {
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
  assert.strictEqual(buffer.slice(0, 2).toString(), 'PK');
  console.log('ALL CHECKS PASSED');
}).catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
docker-compose -f docker-compose.dev.yml exec server node scripts/checkAttendanceExport.js
```

Expected: FAIL with `Cannot find module '../utils/attendanceExport'`.

- [ ] **Step 3: Implement the module**

Create `server/utils/attendanceExport.js`:

```js
// Pure helpers for the reports attendance export (CSV / TSV / XLSX).
// buildExportTable produces { headers, rows }; the to* functions serialize it.
const ExcelJS = require('exceljs');

function formatDateHeader(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';
  return date.toISOString().split('T')[0];
}

// sessions: [{ session_date, gathering_type_id, gathering_name }] ordered by date then name
// people: rows from the export people query
// attendanceMap: Map keyed by `${individualId}_${sessionDate}_${gatheringTypeId}` -> boolean
function buildExportTable({ sessions, people, attendanceMap, includeGatheringInHeaders }) {
  const dateHeaders = sessions.map(session => includeGatheringInHeaders
    ? `${formatDateHeader(session.session_date)} – ${session.gathering_name}`
    : formatDateHeader(session.session_date));

  const headers = [
    'First Name', 'Last Name', 'Family Name', 'People Type', 'Adult/Child',
    'Present Count', 'Absent Count',
    ...dateHeaders,
  ];

  const rows = people.map(person => {
    const attendance = sessions.map(session =>
      attendanceMap.get(`${person.id}_${session.session_date}_${session.gathering_type_id}`) === true
    );
    const presentCount = attendance.filter(Boolean).length;
    return [
      person.first_name || '',
      person.last_name || '',
      person.family_name || '',
      person.people_type || '',
      person.is_child ? 'Child' : 'Adult',
      presentCount,
      attendance.length - presentCount,
      ...attendance.map(present => (present ? 'TRUE' : 'FALSE')),
    ];
  });

  return { headers, rows };
}

function csvEscape(value) {
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function tsvSanitize(value) {
  return String(value).replace(/[\t\n\r]+/g, ' ');
}

function toCsv(table) {
  return [table.headers, ...table.rows]
    .map(row => row.map(csvEscape).join(','))
    .join('\n');
}

function toTsv(table) {
  return [table.headers, ...table.rows]
    .map(row => row.map(tsvSanitize).join('\t'))
    .join('\n');
}

async function toXlsx(table) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Attendance');
  worksheet.addRow(table.headers);
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  table.rows.forEach(row => worksheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { buildExportTable, toCsv, toTsv, toXlsx };
```

- [ ] **Step 4: Run the check script to verify it passes**

```bash
docker-compose -f docker-compose.dev.yml exec server node scripts/checkAttendanceExport.js
```

Expected: `ALL CHECKS PASSED`.

- [ ] **Step 5: Commit**

```bash
git add server/utils/attendanceExport.js server/scripts/checkAttendanceExport.js
git commit -m "feat(server): attendance export table builder with csv/tsv/xlsx serializers"
```

---

### Task 3: Rework the /api/reports/export route

**Files:**
- Modify: `server/routes/reports.js:576-739` (the `router.get('/export', ...)` handler)

- [ ] **Step 1: Import the module**

At the top of `server/routes/reports.js`, next to the existing requires, add:

```js
const { buildExportTable, toCsv, toTsv, toXlsx } = require('../utils/attendanceExport');
```

- [ ] **Step 2: Read the format param**

In the handler, change the destructuring line (`reports.js:578`) to:

```js
    const { gatheringTypeId, gatheringTypeIds, startDate, endDate, format: rawFormat } = req.query;
    const format = ['csv', 'tsv', 'xlsx'].includes(rawFormat) ? rawFormat : 'tsv';
```

- [ ] **Step 3: Make the sessions query gathering-aware**

Replace the `sessionsQuery` (`reports.js:597-606`) with (adds `gathering_type_id` to the select and a deterministic secondary sort):

```js
    const sessionsQuery = `
      SELECT DISTINCT as_table.session_date, as_table.gathering_type_id, gt.name as gathering_name
      FROM attendance_sessions as_table
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      WHERE as_table.session_date >= ? AND as_table.session_date <= ?
      AND as_table.gathering_type_id IN (${placeholders})
      AND as_table.church_id = ?
      AND as_table.excluded_from_stats = 0
      ORDER BY as_table.session_date ASC, gt.name ASC
    `;
```

- [ ] **Step 4: Make the attendance lookup gathering-aware**

Replace the `attendanceQuery` (`reports.js:660-671`) with (adds `gathering_type_id`):

```js
    const attendanceQuery = `
      SELECT 
        ar.individual_id,
        as_table.session_date,
        as_table.gathering_type_id,
        ar.present
      FROM attendance_records ar
      JOIN attendance_sessions as_table ON ar.session_id = as_table.id
      WHERE as_table.session_date >= ? AND as_table.session_date <= ?
      AND as_table.gathering_type_id IN (${placeholders})
      AND as_table.church_id = ?
      AND as_table.excluded_from_stats = 0
    `;
```

And replace the map construction (`reports.js:679-683`) with:

```js
    const attendanceMap = new Map();
    attendanceData.forEach(record => {
      const key = `${record.individual_id}_${record.session_date}_${record.gathering_type_id}`;
      attendanceMap.set(key, record.present === 1 || record.present === true);
    });
```

- [ ] **Step 5: Replace the TSV assembly with the module + per-format response**

Delete everything from the `formatDateHeader` helper (`reports.js:685-696`) through `res.send(tsvContent);` (`reports.js:730`) — i.e. the helper, `tsvHeaders`, `tsvRows`, `tsvContent`, and the response block — and replace with:

```js
    const table = buildExportTable({
      sessions,
      people: allPeople,
      attendanceMap,
      includeGatheringInHeaders: gatheringIds.length > 1
    });

    console.log(`Generated ${format} export with ${table.rows.length} data rows and ${sessions.length} date columns`);

    if (format === 'xlsx') {
      const buffer = await toXlsx(table);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="attendance-export.xlsx"');
      res.send(buffer);
    } else if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="attendance-export.csv"');
      res.send(toCsv(table));
    } else {
      res.setHeader('Content-Type', 'text/tab-separated-values');
      res.setHeader('Content-Disposition', 'attachment; filename="attendance-export.tsv"');
      res.send(toTsv(table));
    }
```

(Keep the trailing `console.log('Export completed successfully');` and the catch block unchanged.)

- [ ] **Step 6: Verify the server reloaded cleanly**

```bash
docker-compose -f docker-compose.dev.yml logs --tail=30 server
```

Expected: nodemon restart with no `SyntaxError`/crash; server listening.

- [ ] **Step 7: Commit**

```bash
git add server/routes/reports.js
git commit -m "feat(reports): export format param, count columns, per-gathering date columns"
```

---

### Task 4: Client — API param, preference key, split Export button

**Files:**
- Modify: `client/src/services/api.ts:647-648` (`reportsAPI.exportData`)
- Modify: `client/src/services/userPreferences.ts` (`PREFERENCE_KEYS`)
- Modify: `client/src/pages/ReportsPage.tsx` (imports, state, `handleExportData`, Export button JSX)

- [ ] **Step 1: Extend the API client signature**

In `client/src/services/api.ts` replace:

```ts
  exportData: (params?: { gatheringTypeId?: number; startDate?: string; endDate?: string }) =>
    api.get('/reports/export', { params, responseType: 'blob' }),
```

with (the page passes `gatheringTypeIds`, so fix the stale param type too):

```ts
  exportData: (params?: { gatheringTypeIds?: number[]; startDate?: string; endDate?: string; format?: 'csv' | 'tsv' | 'xlsx' }) =>
    api.get('/reports/export', { params, responseType: 'blob' }),
```

- [ ] **Step 2: Add the preference key**

In `client/src/services/userPreferences.ts`, add to `PREFERENCE_KEYS`:

```ts
  REPORTS_EXPORT_FORMAT: 'reports_export_format',
```

- [ ] **Step 3: Add format metadata, state, and click-outside handling in ReportsPage**

In `client/src/pages/ReportsPage.tsx`:

Update the React import to include `useRef`:

```tsx
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
```

Add `ChevronDownIcon` to the heroicons import block:

```tsx
import {
  ChartBarIcon,
  UsersIcon,
  ArrowTrendingUpIcon,
  ArrowDownTrayIcon,
  XMarkIcon,
  ChevronDownIcon
} from '@heroicons/react/24/outline';
```

Update the userPreferences import:

```tsx
import { userPreferences, PREFERENCE_KEYS } from '../services/userPreferences';
```

At module scope (below the `CaregiverSearchResult` interface, before `const ReportsPage`):

```tsx
type ExportFormat = 'csv' | 'xlsx' | 'tsv';

const EXPORT_FORMATS: { id: ExportFormat; label: string; mime: string }[] = [
  { id: 'csv', label: 'CSV', mime: 'text/csv' },
  { id: 'xlsx', label: 'Excel (.xlsx)', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'tsv', label: 'TSV', mime: 'text/tab-separated-values' },
];
```

Inside the component (near the other `useState` declarations at the top):

```tsx
  const [exportFormat, setExportFormat] = useState<ExportFormat>(() => {
    const saved = userPreferences.getLocalPreference<{ format?: ExportFormat }>(PREFERENCE_KEYS.REPORTS_EXPORT_FORMAT);
    return saved?.format && EXPORT_FORMATS.some(f => f.id === saved.format) ? saved.format : 'csv';
  });
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Close the export format menu when clicking outside (same pattern as ActionMenu)
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [exportMenuOpen]);
```

- [ ] **Step 4: Update handleExportData**

Replace the current `handleExportData` (`ReportsPage.tsx:779-836`) with:

```tsx
  const handleExportData = async (formatOverride?: ExportFormat) => {
    if (selectedGatherings.length === 0 || !startDate || !endDate) {
      setError('Please select at least one gathering and date range before exporting');
      return;
    }

    const format = formatOverride ?? exportFormat;
    const formatMeta = EXPORT_FORMATS.find(f => f.id === format)!;
    if (format !== exportFormat) {
      setExportFormat(format);
    }
    userPreferences.setLocalPreference(PREFERENCE_KEYS.REPORTS_EXPORT_FORMAT, { format });

    try {
      setIsLoading(true);
      setError('');

      const params = {
        gatheringTypeIds: selectedGatherings.map(g => g.id),
        startDate,
        endDate,
        format
      };

      logger.log('Exporting data with params:', params);

      const response = await reportsAPI.exportData(params);

      logger.log('Export response received:', response);

      // Check if response has data
      if (!response.data) {
        throw new Error('No data received from server');
      }

      // Create and download the file
      const blob = new Blob([response.data], { type: formatMeta.mime });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const gatheringNames = selectedGatherings.map(g => g.name).join('-');
      a.download = `attendance-report-${gatheringNames}-${startDate}-to-${endDate}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      logger.log('File download initiated successfully');

    } catch (err: any) {
      console.error('Export error:', err);
      console.error('Error response:', err.response);

      let errorMessage = 'Failed to export data';

      if (err.response?.data?.error) {
        errorMessage = err.response.data.error;
      } else if (err.message) {
        errorMessage = err.message;
      }

      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };
```

- [ ] **Step 5: Replace the Export button with a split button**

Replace the Export button JSX (`ReportsPage.tsx:942-948`):

```tsx
              <button 
                onClick={handleExportData}
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
              >
                <ArrowDownTrayIcon className="h-4 w-4 mr-2" />
                Export Data
              </button>
```

with:

```tsx
              <div className="relative inline-flex rounded-md shadow-sm" ref={exportMenuRef}>
                <button
                  onClick={() => handleExportData()}
                  className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-l-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                >
                  <ArrowDownTrayIcon className="h-4 w-4 mr-2" />
                  Export {EXPORT_FORMATS.find(f => f.id === exportFormat)?.label}
                </button>
                <button
                  onClick={() => setExportMenuOpen(open => !open)}
                  className="inline-flex items-center px-2 py-2 -ml-px border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-r-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                  title="Choose export format"
                >
                  <ChevronDownIcon className="h-4 w-4" />
                </button>
                {exportMenuOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-44 bg-white dark:bg-gray-800 rounded-md shadow-lg ring-1 ring-black dark:ring-gray-700 ring-opacity-5">
                    <div className="py-1">
                      {EXPORT_FORMATS.map(f => (
                        <button
                          key={f.id}
                          onClick={() => { setExportMenuOpen(false); handleExportData(f.id); }}
                          className={`block w-full text-left px-4 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-600 ${f.id === exportFormat ? 'font-semibold text-primary-600 dark:text-primary-400' : 'text-gray-700 dark:text-gray-300'}`}
                        >
                          Export as {f.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
```

- [ ] **Step 6: Type-check/build via Docker**

```bash
docker-compose -f docker-compose.dev.yml build client
docker-compose -f docker-compose.dev.yml up -d client
docker-compose -f docker-compose.dev.yml logs --tail=30 client
```

Expected: build succeeds; dev server starts with no TypeScript/compile errors in logs.

- [ ] **Step 7: Commit**

```bash
git add client/src/services/api.ts client/src/services/userPreferences.ts client/src/pages/ReportsPage.tsx
git commit -m "feat(reports): export format split button with persisted default"
```

---

### Task 5: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Bring up the full dev stack**

```bash
docker-compose -f docker-compose.dev.yml up -d
```

- [ ] **Step 2: Verify in the browser (http://localhost:3000 → Reports page)**

Checklist:
1. Export button reads "Export CSV" on first load (no saved preference).
2. Single gathering + date range → Export CSV: file opens in a spreadsheet; columns are `First Name, Last Name, Family Name, People Type, Adult/Child, Present Count, Absent Count, <dates>`; no gathering name in headers; Present + Absent = number of date columns per row; any field containing a comma survives intact.
3. Dropdown → "Export as Excel (.xlsx)": file downloads with `.xlsx` extension and opens in Excel/Numbers with a bold frozen header row; main button now reads "Export Excel (.xlsx)".
4. Reload the page: main button still reads "Export Excel (.xlsx)" (preference persisted).
5. Select two gatherings (ideally sharing a date) → Export CSV: date headers read `YYYY-MM-DD – <Gathering Name>`; same-date columns for different gatherings show different values when attendance differs.
6. Dropdown → "Export as TSV": tab-separated file matches the old format plus the two new count columns.

- [ ] **Step 3: Check server logs for errors**

```bash
docker-compose -f docker-compose.dev.yml logs --tail=50 server
```

Expected: `Generated csv/xlsx/tsv export ...` lines, no stack traces.
