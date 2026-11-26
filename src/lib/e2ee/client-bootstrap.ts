import { authFetch } from '@/lib/auth-client';
import { clearCachedE2eeCryptoHelpers } from '@/lib/e2ee/cipher';
import {
  clearInMemoryKeystore,
  getBackupDeviceKeyMaterial,
  getBootstrapDeviceKeyMaterial,
  getOrCreatePrimaryDeviceKeyMaterial,
  importAndStoreBootstrapKeyMaterial,
  saveDeviceKeyMaterial,
} from '@/lib/e2ee/keystore';
import type { E2eePrivateJwk, E2eePublicJwk } from '@/lib/e2ee/types';
import type { E2eeKeyBackupDto } from '@/modules/chat';

const SESSION_STORAGE_REG_PREFIX = 'tomato_e2ee_reg:';
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

export type BootstrapFetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const inFlightBootstrapByUser = new Map<string, Promise<boolean>>();
const registeredFingerprintByUser = new Map<string, string>();
const deviceRegisterCooldownUntilByUser = new Map<string, number>();

const inFlightBackupFetchByUser = new Map<string, Promise<E2eeKeyBackupDto | null>>();
const cachedServerBackupByUser = new Map<
  string,
  { readonly fetched: boolean; readonly backup: E2eeKeyBackupDto | null }
>();
const backupReadCooldownUntilByUser = new Map<string, number>();

function normalizeUserKey(userPublicId: string): string {
  return userPublicId.trim().toLowerCase();
}

function getSessionStorageKey(userPublicId: string): string {
  return `${SESSION_STORAGE_REG_PREFIX}${normalizeUserKey(userPublicId)}`;
}

function readRegisteredFingerprintFromSession(userPublicId: string): string | null {
  const norm = normalizeUserKey(userPublicId);
  const inMemory = registeredFingerprintByUser.get(norm);
  if (inMemory) {
    return inMemory;
  }
  if (typeof globalThis.sessionStorage === 'undefined') {
    return null;
  }
  try {
    const stored = globalThis.sessionStorage.getItem(getSessionStorageKey(norm));
    if (stored && /^[0-9a-f]{64}$/i.test(stored)) {
      const normalizedFp = stored.toLowerCase();
      registeredFingerprintByUser.set(norm, normalizedFp);
      return normalizedFp;
    }
  } catch {
    // Bỏ qua nếu trình duyệt chặn sessionStorage.
  }
  return null;
}

/**
 * Ghi nhận cặp `(userPublicId, keyFingerprint)` đã được đăng ký thành công với Server trong phiên hiện tại.
 * Lưu ý bảo mật: `keyFingerprint` chỉ là mã băm công khai SHA-256 (64 ký tự hex), tuyệt đối không chứa khóa riêng.
 */
export function markE2eeDeviceFingerprintRegistered(
  userPublicId: string,
  keyFingerprint: string,
): void {
  const normUser = normalizeUserKey(userPublicId);
  const normFp = keyFingerprint.trim().toLowerCase();
  if (!normUser || !normFp) {
    return;
  }
  registeredFingerprintByUser.set(normUser, normFp);
  if (typeof globalThis.sessionStorage !== 'undefined') {
    try {
      globalThis.sessionStorage.setItem(getSessionStorageKey(normUser), normFp);
    } catch {
      // Bỏ qua nếu sessionStorage không khả dụng.
    }
  }
}

export function isE2eeDeviceFingerprintRegisteredInSession(
  userPublicId: string,
  keyFingerprint: string,
): boolean {
  const recorded = readRegisteredFingerprintFromSession(userPublicId);
  return recorded !== null && recorded === keyFingerprint.trim().toLowerCase();
}

async function parseCooldownMsFromErrorResponse(response: Response): Promise<number> {
  const retryAfterHeader = response.headers.get('Retry-After');
  if (retryAfterHeader) {
    const parsedSec = Number(retryAfterHeader);
    if (Number.isFinite(parsedSec) && parsedSec > 0) {
      return Math.min(15 * 60 * 1000, Math.ceil(parsedSec * 1000));
    }
  }
  try {
    const body = (await response.clone().json()) as {
      readonly error?: { readonly retryAfterSeconds?: number };
    } | null;
    const retrySec = body?.error?.retryAfterSeconds;
    if (typeof retrySec === 'number' && Number.isFinite(retrySec) && retrySec > 0) {
      return Math.min(15 * 60 * 1000, Math.ceil(retrySec * 1000));
    }
  } catch {
    // Bỏ qua nếu body không phải JSON.
  }
  return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

export interface EnsureE2eeDeviceRegisteredOptions {
  readonly fetchFn?: BootstrapFetchFn;
  readonly now?: () => number;
}

/**
 * Singleton Promise khởi tạo & đăng ký khóa thiết bị E2EE:
 * 1. Khử trùng lặp hoàn toàn các lời gọi đang bay (in-flight deduplication) — miễn nhiễm với React StrictMode và chuyển trang.
 * 2. Ghi nhớ trạng thái đã đăng ký theo `(userPublicId, keyFingerprint)` trong phiên để chỉ gọi `POST /api/v1/e2ee/devices` đúng 1 lần duy nhất.
 * 3. Tôn trọng `Retry-After` khi gặp `429` hoặc `4xx`, không bao giờ gây vòng lặp retry.
 */
export async function ensureE2eeDeviceRegisteredSingleton(
  userPublicId: string,
  options: EnsureE2eeDeviceRegisteredOptions = {},
): Promise<boolean> {
  const normUser = normalizeUserKey(userPublicId);
  if (!normUser) {
    return false;
  }

  const nowFn = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchFn ?? authFetch;

  const cooldownUntil = deviceRegisterCooldownUntilByUser.get(normUser) ?? 0;
  if (nowFn() < cooldownUntil) {
    return false;
  }

  const existingInFlight = inFlightBootstrapByUser.get(normUser);
  if (existingInFlight) {
    return existingInFlight;
  }

  const promise = (async (): Promise<boolean> => {
    try {
      const material = await getOrCreatePrimaryDeviceKeyMaterial(userPublicId);

      // Nếu thiết bị với đúng `keyFingerprint` này đã được đăng ký thành công trong phiên hiện tại,
      // trả về ngay lập tức mà KHÔNG gọi lại POST /api/v1/e2ee/devices.
      if (registeredFingerprintByUser.get(normUser) === material.keyFingerprint.toLowerCase()) {
        return true;
      }

      const sessionRecordedFp = readRegisteredFingerprintFromSession(normUser);
      if (sessionRecordedFp === material.keyFingerprint.toLowerCase()) {
        const localBootstrap = await getBootstrapDeviceKeyMaterial(userPublicId);
        if (localBootstrap) {
          registeredFingerprintByUser.set(normUser, material.keyFingerprint.toLowerCase());
          return true;
        }
      }

      const currentCooldown = deviceRegisterCooldownUntilByUser.get(normUser) ?? 0;
      if (nowFn() < currentCooldown) {
        return false;
      }

      const response = await fetchImpl('/api/v1/e2ee/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identityPublicKeyJwk: material.identityPublicKeyJwk,
          signingPublicKeyJwk: material.signingPublicKeyJwk,
          keyFingerprint: material.keyFingerprint,
          deviceLabel: 'Trình duyệt web',
        }),
      });

      if (!response.ok) {
        if (response.status === 429 || (response.status >= 400 && response.status < 500)) {
          const waitMs = await parseCooldownMsFromErrorResponse(response);
          deviceRegisterCooldownUntilByUser.set(normUser, nowFn() + waitMs);
        }
        return false;
      }

      const data = (await response.json()) as {
        readonly device?: { readonly devicePublicId?: string };
        readonly bootstrapKeyPair?: {
          readonly keyFingerprint: string;
          readonly identityPublicKeyJwk: E2eePublicJwk;
          readonly identityPrivateJwk: E2eePrivateJwk;
          readonly signingPublicKeyJwk: E2eePublicJwk;
          readonly signingPrivateJwk: E2eePrivateJwk;
        };
      };

      if (
        typeof data.device?.devicePublicId === 'string' &&
        data.device.devicePublicId !== material.devicePublicId
      ) {
        await saveDeviceKeyMaterial(
          {
            ...material,
            devicePublicId: data.device.devicePublicId,
          },
          'primary',
        );
      }

      if (data.bootstrapKeyPair) {
        await importAndStoreBootstrapKeyMaterial(userPublicId, data.bootstrapKeyPair);
      }

      markE2eeDeviceFingerprintRegistered(userPublicId, material.keyFingerprint);
      deviceRegisterCooldownUntilByUser.delete(normUser);
      return true;
    } catch {
      return false;
    } finally {
      inFlightBootstrapByUser.delete(normUser);
    }
  })();

  inFlightBootstrapByUser.set(normUser, promise);
  return promise;
}

export interface LazyFetchKeyBackupOptions {
  readonly hasKeyBackupOnServer?: boolean;
  readonly expectedBackupFingerprint?: string | null;
  readonly forceRefresh?: boolean;
  readonly fetchFn?: BootstrapFetchFn;
  readonly now?: () => number;
}

/**
 * Tải lười (Lazy & Deduplicated) bản sao lưu khóa mã PIN `GET /api/v1/e2ee/backup`:
 * - KHÔNG gọi API nếu `hasKeyBackupOnServer === false`.
 * - KHÔNG gọi API nếu thiết bị cục bộ trong IndexedDB đã có sẵn khóa `backup` trùng khớp `expectedBackupFingerprint` (trừ khi `forceRefresh === true`).
 * - Chỉ gọi tối đa 1 lần trong phiên và lưu cache RAM, tôn trọng `Retry-After` nếu gặp `429`.
 */
export async function fetchServerKeyBackupLazySingleton(
  userPublicId: string,
  options: LazyFetchKeyBackupOptions = {},
): Promise<E2eeKeyBackupDto | null> {
  const normUser = normalizeUserKey(userPublicId);
  if (!normUser) {
    return null;
  }

  if (options.hasKeyBackupOnServer === false) {
    cachedServerBackupByUser.set(normUser, { fetched: true, backup: null });
    return null;
  }

  if (!options.forceRefresh) {
    const cached = cachedServerBackupByUser.get(normUser);
    if (cached?.fetched) {
      return cached.backup;
    }

    if (options.expectedBackupFingerprint) {
      const localBackup = await getBackupDeviceKeyMaterial(userPublicId);
      if (
        localBackup &&
        localBackup.keyFingerprint.toLowerCase() ===
          options.expectedBackupFingerprint.trim().toLowerCase()
      ) {
        // Thiết bị đã có sẵn khóa đồng bộ hợp lệ trong IndexedDB -> không cần tải lại blob từ Server.
        return null;
      }
    }
  }

  const nowFn = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchFn ?? authFetch;

  const cooldownUntil = backupReadCooldownUntilByUser.get(normUser) ?? 0;
  if (nowFn() < cooldownUntil) {
    return cachedServerBackupByUser.get(normUser)?.backup ?? null;
  }

  const existingInFlight = inFlightBackupFetchByUser.get(normUser);
  if (existingInFlight) {
    return existingInFlight;
  }

  const promise = (async (): Promise<E2eeKeyBackupDto | null> => {
    try {
      const response = await fetchImpl('/api/v1/e2ee/backup', {
        method: 'GET',
      });
      if (!response.ok) {
        if (response.status === 429 || (response.status >= 400 && response.status < 500)) {
          const waitMs = await parseCooldownMsFromErrorResponse(response);
          backupReadCooldownUntilByUser.set(normUser, nowFn() + waitMs);
        }
        return cachedServerBackupByUser.get(normUser)?.backup ?? null;
      }

      const data = (await response.json()) as { readonly backup?: E2eeKeyBackupDto | null };
      const backup = data.backup ?? null;
      cachedServerBackupByUser.set(normUser, { fetched: true, backup });
      backupReadCooldownUntilByUser.delete(normUser);
      return backup;
    } catch {
      return cachedServerBackupByUser.get(normUser)?.backup ?? null;
    } finally {
      inFlightBackupFetchByUser.delete(normUser);
    }
  })();

  inFlightBackupFetchByUser.set(normUser, promise);
  return promise;
}

export function setCachedServerKeyBackupInSession(
  userPublicId: string,
  backup: E2eeKeyBackupDto | null,
): void {
  const normUser = normalizeUserKey(userPublicId);
  if (!normUser) {
    return;
  }
  cachedServerBackupByUser.set(normUser, { fetched: true, backup });
}

/**
 * Xóa sạch toàn bộ trạng thái Singleton E2EE Bootstrap, bộ đệm backup, cooldown
 * và các khóa `tomato_e2ee_reg:*` trong `sessionStorage` khi người dùng đăng xuất.
 */
export function clearE2eeClientBootstrapState(): void {
  clearInMemoryKeystore();
  clearCachedE2eeCryptoHelpers();
  inFlightBootstrapByUser.clear();
  registeredFingerprintByUser.clear();
  deviceRegisterCooldownUntilByUser.clear();
  inFlightBackupFetchByUser.clear();
  cachedServerBackupByUser.clear();
  backupReadCooldownUntilByUser.clear();

  if (typeof globalThis.sessionStorage !== 'undefined') {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < globalThis.sessionStorage.length; i += 1) {
        const key = globalThis.sessionStorage.key(i);
        if (key && key.startsWith(SESSION_STORAGE_REG_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        globalThis.sessionStorage.removeItem(key);
      }
    } catch {
      // Bỏ qua nếu trình duyệt chặn truy cập sessionStorage.
    }
  }
}
