import { describe, expect, it, vi } from 'vitest';

import {
  CLOUDFLARE_DUMMY_SECRET_ALREADY_SPENT,
  CLOUDFLARE_DUMMY_SECRET_ALWAYS_FAIL,
  CLOUDFLARE_DUMMY_SECRET_ALWAYS_PASS,
  TURNSTILE_VERIFY_ENDPOINT,
  TurnstileAdapter,
} from '@/core/captcha';

describe('Unit M2: TurnstileAdapter (Cloudflare Turnstile)', () => {
  it('gửi POST đúng định dạng x-www-form-urlencoded và trả success=true khi siteverify hợp lệ', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ success: true, action: 'register' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const adapter = new TurnstileAdapter({
      secretKey: 'real-synthetic-secret-key-for-unit-test',
      nodeEnv: 'production',
      fetchImpl: fetchMock,
    });

    const result = await adapter.verify({
      token: 'valid-turnstile-token',
      remoteIp: '203.0.113.10',
      expectedAction: 'register',
    });

    expect(result).toEqual({ success: true, errorCodes: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(TURNSTILE_VERIFY_ENDPOINT);
    expect(init?.method).toBe('POST');
    const bodyParams = new URLSearchParams(String(init?.body ?? ''));
    expect(bodyParams.get('secret')).toBe('real-synthetic-secret-key-for-unit-test');
    expect(bodyParams.get('response')).toBe('valid-turnstile-token');
    expect(bodyParams.get('remoteip')).toBe('203.0.113.10');
  });

  it('fail-closed khi token rỗng, siteverify trả success=false, HTTP 500 hoặc lỗi mạng/timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = new TurnstileAdapter({
      secretKey: 'real-synthetic-secret-key-for-unit-test',
      nodeEnv: 'production',
      fetchImpl: fetchMock,
    });

    // Token rỗng bị từ chối ngay mà không gọi mạng.
    const emptyResult = await adapter.verify({ token: '   ' });
    expect(emptyResult.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // Cloudflare trả success: false.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
        status: 200,
      }),
    );
    expect(await adapter.verify({ token: 'bad-token' })).toEqual({
      success: false,
      errorCodes: ['invalid-input-response'],
    });

    // Lỗi HTTP 500 -> fail-closed.
    fetchMock.mockResolvedValueOnce(new Response('Upstream error', { status: 500 }));
    expect(await adapter.verify({ token: 'some-token' })).toEqual({
      success: false,
      errorCodes: ['http-500'],
    });

    // Lỗi mạng / timeout -> fail-closed.
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'TimeoutError'));
    expect(await adapter.verify({ token: 'some-token' })).toEqual({
      success: false,
      errorCodes: ['network-error'],
    });
  });

  it('hỗ trợ đúng hợp đồng 3 Cloudflare dummy test secret key trong môi trường test', async () => {
    const passAdapter = new TurnstileAdapter({
      secretKey: CLOUDFLARE_DUMMY_SECRET_ALWAYS_PASS,
      nodeEnv: 'test',
    });
    expect(await passAdapter.verify({ token: 'XXXX.DUMMY.TOKEN.XXXX' })).toEqual({
      success: true,
      errorCodes: [],
    });

    const failAdapter = new TurnstileAdapter({
      secretKey: CLOUDFLARE_DUMMY_SECRET_ALWAYS_FAIL,
      nodeEnv: 'test',
    });
    expect(await failAdapter.verify({ token: 'XXXX.DUMMY.TOKEN.XXXX' })).toEqual({
      success: false,
      errorCodes: ['invalid-input-response'],
    });

    const spentAdapter = new TurnstileAdapter({
      secretKey: CLOUDFLARE_DUMMY_SECRET_ALREADY_SPENT,
      nodeEnv: 'test',
    });
    expect(await spentAdapter.verify({ token: 'XXXX.DUMMY.TOKEN.XXXX' })).toEqual({
      success: false,
      errorCodes: ['timeout-or-duplicate'],
    });
  });
});
