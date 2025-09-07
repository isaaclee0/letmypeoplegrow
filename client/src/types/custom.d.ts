// Type declarations for modules without type definitions

declare module 'socket.io-client' {
  const io: any;
  export default io;
  export interface Socket {}
}

declare module './ToastContext' {
  export const useToast: () => {
    showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
  };
}

declare module './SettingsContext' {
  export const useSettings: () => {
    settings: any;
    updateSettings: (settings: any) => void;
  };
}

declare module 'react-i18next' {
  export const useTranslation: () => {
    t: (key: string, options?: any) => string;
    i18n: any;
  };
}

declare module 'react-router-dom' {
  export const useNavigate: () => (path: string) => void;
}

declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}