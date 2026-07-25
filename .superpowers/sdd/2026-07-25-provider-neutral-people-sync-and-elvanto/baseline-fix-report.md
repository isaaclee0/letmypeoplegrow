# Client Test Baseline Fix Report

- Status: `DONE`
- Commit hash: `PENDING`

## Root cause and evidence

Node `v26.5.0` provides an experimental `localStorage` global that is
`undefined` without `--localstorage-file`. Vitest's JSDOM environment only
copies window globals that are not already present in Node, so it retains that
Node binding. Vitest then aliases `window` to the global test object; both
`window.localStorage` and bare `localStorage` therefore resolve to the
undefined Node binding instead of JSDOM's usable Storage object.

Evidence:

- `node -e "console.log(Object.getOwnPropertyDescriptor(globalThis, 'localStorage'))"`
  showed Node's configurable getter.
- Vitest's installed JSDOM environment adapter filters window globals already
  present in Node (`getWindowKeys`), then sets `global.window = global`.
- The original focused run produced the Node experimental-localStorage warning
  and three `localStorage.clear()` failures.

## Red test

Command:

```bash
cd client && npm test -- --reporter=verbose src/pages/AttendancePage.groupByFamily.test.ts
```

Expected failure observed: the new shared-environment regression test failed
with `expected undefined to be defined` for `window.localStorage`, and the
three existing tests failed at `localStorage.clear()` with `TypeError: Cannot
read properties of undefined (reading 'clear')` (4 failed tests total).

## Implementation

Changed files:

- `client/src/setupTests.ts` — obtains Vitest's real JSDOM window and binds its
  `localStorage` to `globalThis` once for the shared client test environment.
- `client/src/pages/AttendancePage.groupByFamily.test.ts` — adds a narrow
  regression test proving client tests can read and write JSDOM Web Storage.

No dependencies or browser-runtime code changed.

## Green verification

```bash
cd client && npm test -- --reporter=verbose src/pages/AttendancePage.groupByFamily.test.ts
```

Passed: 1 file, 4 tests.

```bash
cd client && npm test
```

Passed: 6 files, 32 tests.

```bash
cd client && npm run build
```

Passed: production build completed successfully.

```bash
git diff --check
```

Passed with no whitespace errors.

## Self-review and concerns

The repair is limited to test setup and uses JSDOM's actual Storage
implementation, rather than a per-test or in-memory shim. Node continues to
emit its unrelated `DEP0205` deprecation warning during Vitest/build runs, and
Vite reports the existing large-chunk warning during the build; neither is
introduced by this change.
