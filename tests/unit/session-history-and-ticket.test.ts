import { Writable } from 'node:stream';

import type { ErrorEvent } from '@sentry/nextjs';
import { describe, expect, it } from 'vitest';

import { getUserInitials } from '@/components/layout/app-top-bar';
import { generateSecureToken, hashScopedTokenSha256 } from '@/core/crypto/token';
import type { SessionRow } from '@/core/db/schema';
import { createLogger } from '@/core/logger';
import { scrubSensitiveString, scrubSentryEvent } from '@/core/monitoring/sentry-scrub';
import { sanitizeAuditMetadata } from '@/core/security/audit-log.service';
import { SESSION_ONLINE_THRESHOLD_MS, classifyDeviceSessions } from '@/modules/auth';

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  const baseTime = new Date('2026-11-23T12:00:00.000Z');
  return {
    id: '01950000-0000-7000-8000-000000009001',
    publicId: 'session-pub-1',
    userId: '01950000-0000-7000-8000-000000001001',
    familyId: 'family-1',
    refreshTokenHash: 'a'.repeat(64),
    deviceInfo: 'Chrome 130 / Windows 10/11',
    ipAddress: '203.0.113.10',
    lastUsedAt: baseTime,
    expiresAt: new Date(baseTime.getTime() + 7 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    revokeReason: null,
    createdAt: new Date(baseTime.getTime() - 60 * 60 * 1000),
    ...overrides,
  };
}

describe('Unit: Session Classification (Online/Offline/History), Scoped Ticket Hash & Ticket Redaction', () => {
  it('classifyDeviceSessions phân loại chuẩn thiết bị hiện tại, Online <= 15p, Offline > 15p, Đã đăng xuất và Đã hết hạn mà không lộ ID nội bộ', () => {
    const now = new Date('2026-11-23T12:00:00.000Z');

    const currentOldActivity = makeSessionRow({
      id: '01950000-0000-7000-8000-000000009001',
      publicId: 'pub-current',
      familyId: 'fam-current',
      deviceInfo: 'Chrome 130 / Windows 10/11',
      // Thiết bị hiện tại luôn là Online kể cả lastUsedAt > 15 phút trước.
      lastUsedAt: new Date(now.getTime() - SESSION_ONLINE_THRESHOLD_MS - 60_000),
    });
    const otherOnline = makeSessionRow({
      id: '01950000-0000-7000-8000-000000009002',
      publicId: 'pub-online',
      familyId: 'fam-online',
      deviceInfo: 'Safari 18 / iOS',
      lastUsedAt: new Date(now.getTime() - 5 * 60 * 1000),
    });
    const otherOffline = makeSessionRow({
      id: '01950000-0000-7000-8000-000000009003',
      publicId: 'pub-offline',
      familyId: 'fam-offline',
      deviceInfo: 'Firefox 132 / Linux',
      lastUsedAt: new Date(now.getTime() - SESSION_ONLINE_THRESHOLD_MS - 5 * 60 * 1000),
    });
    const loggedOutDevice = makeSessionRow({
      id: '01950000-0000-7000-8000-000000009004',
      publicId: 'pub-logged-out',
      familyId: 'fam-logged-out',
      deviceInfo: 'Edge 131 / Windows 10/11',
      revokedAt: new Date(now.getTime() - 10 * 60 * 1000),
      revokeReason: 'user_revoked',
    });
    const expiredDevice = makeSessionRow({
      id: '01950000-0000-7000-8000-000000009005',
      publicId: 'pub-expired',
      familyId: 'fam-expired',
      deviceInfo: 'Safari 18 / macOS',
      expiresAt: new Date(now.getTime() - 30 * 60 * 1000),
      revokedAt: null,
    });

    const result = classifyDeviceSessions(
      [otherOffline, expiredDevice, loggedOutDevice, otherOnline, currentOldActivity],
      { currentSessionPublicId: 'pub-current', now },
    );

    expect(result.sessions.map((s) => s.public_id)).toEqual([
      'pub-current',
      'pub-online',
      'pub-offline',
    ]);
    expect(result.sessions[0]?.isCurrent).toBe(true);
    expect(result.sessions[0]?.activityStatus).toBe('online');
    expect(result.sessions[1]?.isCurrent).toBe(false);
    expect(result.sessions[1]?.activityStatus).toBe('online');
    expect(result.sessions[2]?.isCurrent).toBe(false);
    expect(result.sessions[2]?.activityStatus).toBe('offline');

    expect(result.history.map((h) => h.public_id)).toEqual(['pub-logged-out', 'pub-expired']);
    expect(result.history[0]?.historyStatus).toBe('logged_out');
    expect(result.history[1]?.historyStatus).toBe('expired');

    const serialized = JSON.stringify(result);
    for (const secretField of [
      '01950000-0000-7000-8000-000000009001',
      '01950000-0000-7000-8000-000000001001',
      'fam-current',
      'a'.repeat(64),
    ]) {
      expect(serialized).not.toContain(secretField);
    }
  });

  it('hashScopedTokenSha256 ràng buộc chặt ticket vào (purpose, userId, sessionFamilyId) chống dùng chéo', () => {
    const rawTicket = generateSecureToken(32);
    const hashA = hashScopedTokenSha256(rawTicket, {
      purpose: 'password_change_ticket',
      userId: 'user-1',
      sessionFamilyId: 'family-1',
    });
    const hashASame = hashScopedTokenSha256(rawTicket, {
      purpose: 'password_change_ticket',
      userId: 'user-1',
      sessionFamilyId: 'family-1',
    });
    const hashOtherUser = hashScopedTokenSha256(rawTicket, {
      purpose: 'password_change_ticket',
      userId: 'user-2',
      sessionFamilyId: 'family-1',
    });
    const hashOtherFamily = hashScopedTokenSha256(rawTicket, {
      purpose: 'password_change_ticket',
      userId: 'user-1',
      sessionFamilyId: 'family-2',
    });
    const hashOtherPurpose = hashScopedTokenSha256(rawTicket, {
      purpose: 'password_reset',
      userId: 'user-1',
      sessionFamilyId: 'family-1',
    });

    expect(hashA).toMatch(/^[a-f0-9]{64}$/);
    expect(hashA).toBe(hashASame);
    expect(hashA).not.toBe(hashOtherUser);
    expect(hashA).not.toBe(hashOtherFamily);
    expect(hashA).not.toBe(hashOtherPurpose);
  });

  it('che sạch cookie tomato_pwd_ticket / __Host-tomato_pwd_ticket và key ticket trong Pino, AuditLog và Sentry', () => {
    const syntheticTicket = generateSecureToken(32);

    // 1. Pino Logger redaction
    const loggedChunks: string[] = [];
    const memoryStream = new Writable({
      write(chunk, _encoding, callback) {
        loggedChunks.push(String(chunk));
        callback();
      },
    });
    const testLogger = createLogger({ level: 'info', pretty: false, destination: memoryStream });
    testLogger.info(
      {
        ticket: syntheticTicket,
        passwordChangeTicket: syntheticTicket,
        tomato_pwd_ticket: syntheticTicket,
        '__Host-tomato_pwd_ticket': syntheticTicket,
      },
      'test ticket redaction',
    );
    const pinoOutput = loggedChunks.join('');
    expect(pinoOutput).not.toContain(syntheticTicket);
    expect(pinoOutput).toContain('[REDACTED]');

    // 2. Audit Log metadata sanitization: xóa hoàn toàn key nhạy cảm và che value chứa cookie ticket.
    const sanitizedMeta = sanitizeAuditMetadata({
      ticket: syntheticTicket,
      passwordChangeTicket: syntheticTicket,
      rawNote: `tomato_pwd_ticket=${syntheticTicket}`,
      safeFlag: true,
    });
    expect(sanitizedMeta.ticket).toBeUndefined();
    expect(sanitizedMeta.passwordChangeTicket).toBeUndefined();
    expect(sanitizedMeta.rawNote).toBe('[REDACTED]');
    expect(sanitizedMeta.safeFlag).toBe(true);
    expect(JSON.stringify(sanitizedMeta)).not.toContain(syntheticTicket);

    // 3. Sentry string & event scrubber
    const rawCookieHeader = `cookie: __Host-tomato_pwd_ticket=${syntheticTicket}; tomato_pwd_ticket=${syntheticTicket}`;
    const scrubbedString = scrubSensitiveString(rawCookieHeader);
    expect(scrubbedString).not.toContain(syntheticTicket);

    const rawEvent: ErrorEvent = {
      type: undefined,
      message: `failed with tomato_pwd_ticket=${syntheticTicket}`,
      extra: {
        ticket: syntheticTicket,
        passwordChangeTicket: syntheticTicket,
      },
      request: {
        cookies: {
          '__Host-tomato_pwd_ticket': syntheticTicket,
        },
      },
    };
    const scrubbedEvent = scrubSentryEvent(rawEvent);
    const serializedEvent = JSON.stringify(scrubbedEvent);
    expect(serializedEvent).not.toContain(syntheticTicket);
  });

  it('getUserInitials tạo chữ cái đại diện sạch từ họ tên tiếng Việt', () => {
    expect(getUserInitials('Nguyễn Minh Anh')).toBe('NA');
    expect(getUserInitials('An')).toBe('AN');
    expect(getUserInitials('   ')).toBe('T');
  });
});
