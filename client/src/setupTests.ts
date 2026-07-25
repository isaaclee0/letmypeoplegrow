import '@testing-library/jest-dom/vitest';

// Node 26 exposes an experimental localStorage global that Vitest's JSDOM
// environment does not replace. Use the actual JSDOM storage for all client tests.
const jsdomWindow = (globalThis as typeof globalThis & {
  jsdom?: { window: Window };
}).jsdom?.window;

if (jsdomWindow) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: jsdomWindow.localStorage,
  });
}
