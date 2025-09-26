// Connection simulator for testing offline mode
// This utility helps simulate network issues during development

let isSimulatingConnectionIssue = false;
let originalFetch: typeof fetch | null = null;
let originalWebSocket: typeof WebSocket | null = null;

export const simulateConnectionIssue = (duration: number = 15000) => {
  if (isSimulatingConnectionIssue) {
    console.log('🧪 Connection issue simulation already active');
    return;
  }

  console.log(`🧪 Simulating connection issue for ${duration}ms...`);
  isSimulatingConnectionIssue = true;

  // Store original implementations
  originalFetch = window.fetch;
  originalWebSocket = window.WebSocket;

  // Override fetch to simulate network issues
  window.fetch = async (...args) => {
    console.log('🧪 Blocked fetch request:', args[0]);
    throw new Error('Simulated network error');
  };

  // Override WebSocket to simulate connection issues
  window.WebSocket = class MockWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      console.log('🧪 Blocked WebSocket connection:', url);
      // Simulate connection failure
      setTimeout(() => {
        if (this.onerror) {
          this.onerror(new Event('error'));
        }
        if (this.onclose) {
          this.onclose(new CloseEvent('close'));
        }
      }, 100);
    }

    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    close() {
      console.log('🧪 Mock WebSocket closed');
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      console.log('🧪 Mock WebSocket send blocked:', data);
    }

    get readyState() {
      return WebSocket.CLOSED;
    }

    get url() {
      return '';
    }

    get protocol() {
      return '';
    }

    get extensions() {
      return '';
    }

    get bufferedAmount() {
      return 0;
    }

    get binaryType() {
      return 'blob';
    }

    set binaryType(value: BinaryType) {
      // Mock implementation
    }

    addEventListener() {
      // Mock implementation
    }

    removeEventListener() {
      // Mock implementation
    }

    dispatchEvent() {
      return false;
    }
  } as any;

  // Restore original implementations after duration
  setTimeout(() => {
    restoreConnection();
  }, duration);
};

export const restoreConnection = () => {
  if (!isSimulatingConnectionIssue) {
    console.log('🧪 No connection issue simulation active');
    return;
  }

  console.log('🧪 Restoring connection...');
  isSimulatingConnectionIssue = false;

  // Restore original implementations
  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }

  if (originalWebSocket) {
    window.WebSocket = originalWebSocket;
    originalWebSocket = null;
  }
};

export const isConnectionSimulationActive = () => {
  return isSimulatingConnectionIssue;
};
