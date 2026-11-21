'use client';

import * as React from 'react';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';

const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: 'light' | 'dark' | 'auto';
  language?: string;
  callback?: (token: string) => void;
  'expired-callback'?: () => void;
  'error-callback'?: () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let turnstileScriptPromise: Promise<void> | null = null;

function loadTurnstileScript(nonce?: string): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }

  if (window.turnstile) {
    return Promise.resolve();
  }

  if (turnstileScriptPromise) {
    return turnstileScriptPromise;
  }

  turnstileScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
    );
    if (existing) {
      if (window.turnstile) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => {
          turnstileScriptPromise = null;
          reject(new Error('TURNSTILE_SCRIPT_LOAD_FAILED'));
        },
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    // Gắn CSP nonce (nếu có) để tương thích cả CSP Level 2 lẫn `strict-dynamic`.
    if (nonce) {
      script.nonce = nonce;
    }
    script.onload = () => resolve();
    script.onerror = () => {
      turnstileScriptPromise = null;
      reject(new Error('TURNSTILE_SCRIPT_LOAD_FAILED'));
    };
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
}

export interface TurnstileWidgetProps {
  readonly siteKey: string;
  readonly nonce?: string;
  readonly resetSignal: number;
  readonly onTokenChange: (token: string) => void;
}

export function TurnstileWidget({
  siteKey,
  nonce,
  resetSignal,
  onTokenChange,
}: TurnstileWidgetProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const widgetIdRef = React.useRef<string | null>(null);
  const onTokenChangeRef = React.useRef(onTokenChange);

  React.useEffect(() => {
    onTokenChangeRef.current = onTokenChange;
  }, [onTokenChange]);

  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [reloadCount, setReloadCount] = React.useState(0);

  React.useEffect(() => {
    let active = true;

    async function mountWidget() {
      setLoadState('loading');
      try {
        await loadTurnstileScript(nonce);
        if (!active || !containerRef.current || !window.turnstile) {
          return;
        }

        if (widgetIdRef.current) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme: 'light',
          language: 'vi',
          callback: (token) => {
            onTokenChangeRef.current(token);
          },
          'expired-callback': () => {
            onTokenChangeRef.current('');
          },
          'error-callback': () => {
            onTokenChangeRef.current('');
          },
        });
        setLoadState('ready');
      } catch {
        if (active) {
          onTokenChangeRef.current('');
          setLoadState('error');
        }
      }
    }

    void mountWidget();

    return () => {
      active = false;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, nonce, reloadCount]);

  // Token Turnstile chỉ dùng được một lần: tự động reset widget sau mỗi lần submit lỗi.
  React.useEffect(() => {
    if (resetSignal > 0 && widgetIdRef.current && window.turnstile) {
      onTokenChangeRef.current('');
      window.turnstile.reset(widgetIdRef.current);
    }
  }, [resetSignal]);

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className="flex min-h-[65px] items-center justify-center rounded-md border border-dashed border-border/70 bg-muted/20 p-2"
        aria-label="Xác thực bảo mật Cloudflare Turnstile"
      />
      {loadState === 'loading' ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Đang tải hộp xác thực chống bot Cloudflare Turnstile...
        </p>
      ) : null}
      {loadState === 'error' ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <span>
            Không thể tải Cloudflare Turnstile. Kiểm tra kết nối mạng hoặc trình chặn quảng cáo.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              turnstileScriptPromise = null;
              setReloadCount((prev) => prev + 1);
            }}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Thử lại
          </Button>
        </div>
      ) : null}
    </div>
  );
}
