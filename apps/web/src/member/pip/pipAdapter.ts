/** Thin wrapper over the Document Picture-in-Picture API (Chromium only). Kept apart so tests can fake it. */

export const PIP_DEFAULT_SIZE = { width: 320, height: 200 } as const;

export interface PipWindowHandle {
  /** the always-on-top window; render into `window.document.body` */
  window: Window;
  close(): void;
  /** fires once when the PiP window closes (user X button or close()); returns an unsubscribe */
  onClose(cb: () => void): () => void;
}

export interface PipAdapter {
  isSupported(): boolean;
  open(size?: { width: number; height: number }): Promise<PipWindowHandle>;
}

interface DocumentPipApi {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
}

function api(host: Window): DocumentPipApi | undefined {
  const a = (host as unknown as { documentPictureInPicture?: DocumentPipApi }).documentPictureInPicture;
  return a && typeof a.requestWindow === 'function' ? a : undefined;
}

/** Copy the page's styles into the PiP document (CSS modules / vite style tags / links). */
export function copyStyles(from: Document, to: Document): void {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n');
      const el = to.createElement('style');
      el.textContent = css;
      to.head.appendChild(el);
    } catch {
      // cross-origin sheet: cssRules is blocked, fall back to a <link>
      if (sheet.href) {
        const link = to.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        to.head.appendChild(link);
      }
    }
  }
  // copy theme hints set on <html> (e.g. color-scheme) so :root variables resolve the same way
  const rootStyle = from.documentElement.getAttribute('style');
  if (rootStyle) to.documentElement.setAttribute('style', rootStyle);
  for (const a of Array.from(from.documentElement.attributes)) {
    if (a.name.startsWith('data-')) to.documentElement.setAttribute(a.name, a.value);
  }
}

export function createPipAdapter(host: Window = window): PipAdapter {
  return {
    isSupported: () => !!api(host),
    async open(size = PIP_DEFAULT_SIZE) {
      const a = api(host);
      if (!a) throw new Error('PIP_UNSUPPORTED');
      const win = await a.requestWindow({ width: size.width, height: size.height });
      copyStyles(host.document, win.document);
      win.document.title = host.document.title;
      let closed = false;
      const listeners = new Set<() => void>();
      const fire = () => {
        if (closed) return;
        closed = true;
        listeners.forEach((cb) => cb());
        listeners.clear();
      };
      win.addEventListener('pagehide', fire);
      return {
        window: win,
        close() {
          try {
            win.close();
          } finally {
            fire();
          }
        },
        onClose(cb) {
          if (closed) {
            cb();
            return () => undefined;
          }
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      };
    },
  };
}

/** Why the button is hidden/disabled, for a tooltip. */
export const PIP_UNSUPPORTED_REASON = '작은 창 모드는 Chrome·Edge 데스크톱에서만 지원됩니다';
