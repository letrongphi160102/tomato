import type { E2eeDeviceKeyPairMaterial, E2eePublicJwk } from '@/lib/e2ee/types';
import {
  computeDeviceKeyFingerprint,
  getWebCrypto,
  normalizePublicP256Jwk,
} from '@/lib/e2ee/utils';

const IDB_DATABASE_NAME = 'tomato_e2ee_keystore_v1';
const IDB_STORE_NAME = 'device_keys';
const IDB_VERSION = 1;

// Bộ nhớ dự phòng cho môi trường kiểm thử hoặc khi IndexedDB không khả dụng.
const memoryKeystore = new Map<string, E2eeDeviceKeyPairMaterial>();

function buildStoreKey(userPublicId: string, slotOrFingerprint: string): string {
  return `${userPublicId.toLowerCase()}:${slotOrFingerprint.toLowerCase()}`;
}

function isIndexedDbAvailable(): boolean {
  return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
}

function openKeystoreDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(IDB_DATABASE_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Không thể mở IndexedDB'));
  });
}

async function idbGet(key: string): Promise<E2eeDeviceKeyPairMaterial | null> {
  if (!isIndexedDbAvailable()) {
    return memoryKeystore.get(key) ?? null;
  }
  try {
    const db = await openKeystoreDb();
    return await new Promise<E2eeDeviceKeyPairMaterial | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const store = tx.objectStore(IDB_STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as E2eeDeviceKeyPairMaterial | undefined) ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    return memoryKeystore.get(key) ?? null;
  }
}

async function idbPut(key: string, value: E2eeDeviceKeyPairMaterial): Promise<void> {
  memoryKeystore.set(key, value);
  if (!isIndexedDbAvailable()) {
    return;
  }
  try {
    const db = await openKeystoreDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_STORE_NAME);
      const req = store.put(value, key);
      req.onsuccess = () => {
        db.close();
        resolve();
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch {
    // Đã lưu trong memoryKeystore làm fallback an toàn.
  }
}

/**
 * Lưu một cặp khóa thiết bị (hoặc khóa khôi phục từ mã PIN) đã ở trạng thái `extractable: false`
 * vào IndexedDB theo cả slot (`primary` / `backup`) và `keyFingerprint`.
 */
export async function saveDeviceKeyMaterial(
  material: E2eeDeviceKeyPairMaterial,
  slot: 'primary' | 'backup' = 'primary',
): Promise<void> {
  const slotKey = buildStoreKey(material.userPublicId, slot);
  const fingerprintKey = buildStoreKey(material.userPublicId, material.keyFingerprint);
  await Promise.all([idbPut(slotKey, material), idbPut(fingerprintKey, material)]);
}

export async function getPrimaryDeviceKeyMaterial(
  userPublicId: string,
): Promise<E2eeDeviceKeyPairMaterial | null> {
  return idbGet(buildStoreKey(userPublicId, 'primary'));
}

export async function getBackupDeviceKeyMaterial(
  userPublicId: string,
): Promise<E2eeDeviceKeyPairMaterial | null> {
  return idbGet(buildStoreKey(userPublicId, 'backup'));
}

export async function getDeviceKeyMaterialByFingerprint(
  userPublicId: string,
  keyFingerprint: string,
): Promise<E2eeDeviceKeyPairMaterial | null> {
  return idbGet(buildStoreKey(userPublicId, keyFingerprint));
}

/**
 * Lấy toàn bộ các khóa giải mã hiện có của người dùng trên trình duyệt này
 * (bao gồm khóa thiết bị chính và khóa đồng bộ từ mã PIN nếu có).
 */
export async function listLocalDeviceKeyMaterials(
  userPublicId: string,
): Promise<E2eeDeviceKeyPairMaterial[]> {
  const [primary, backup] = await Promise.all([
    getPrimaryDeviceKeyMaterial(userPublicId),
    getBackupDeviceKeyMaterial(userPublicId),
  ]);
  const map = new Map<string, E2eeDeviceKeyPairMaterial>();
  if (primary) {
    map.set(primary.keyFingerprint, primary);
  }
  if (backup) {
    map.set(backup.keyFingerprint, backup);
  }
  return Array.from(map.values());
}

/**
 * Sinh cặp khóa thiết bị mới bằng WebCrypto với khóa riêng `extractable: false`
 * (ECDH P-256 để thỏa thuận khóa + ECDSA P-256 để ký xác thực người gửi) và lưu vào IndexedDB.
 */
export async function getOrCreatePrimaryDeviceKeyMaterial(
  userPublicId: string,
  devicePublicId?: string,
): Promise<E2eeDeviceKeyPairMaterial> {
  const existing = await getPrimaryDeviceKeyMaterial(userPublicId);
  if (existing) {
    if (devicePublicId && existing.devicePublicId !== devicePublicId) {
      const updated: E2eeDeviceKeyPairMaterial = {
        ...existing,
        devicePublicId,
      };
      await saveDeviceKeyMaterial(updated, 'primary');
      return updated;
    }
    return existing;
  }

  const cryptoObj = getWebCrypto();
  const [identityPair, signingPair] = await Promise.all([
    cryptoObj.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false, // extractable: false — khóa riêng không thể xuất ra khỏi WebCrypto/IndexedDB
      ['deriveBits'],
    ),
    cryptoObj.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // extractable: false
      ['sign', 'verify'],
    ),
  ]);

  const [rawIdentityPub, rawSigningPub] = await Promise.all([
    cryptoObj.subtle.exportKey('jwk', identityPair.publicKey),
    cryptoObj.subtle.exportKey('jwk', signingPair.publicKey),
  ]);

  const identityPublicKeyJwk: E2eePublicJwk = normalizePublicP256Jwk(rawIdentityPub);
  const signingPublicKeyJwk: E2eePublicJwk = normalizePublicP256Jwk(rawSigningPub);
  const keyFingerprint = await computeDeviceKeyFingerprint(
    identityPublicKeyJwk,
    signingPublicKeyJwk,
  );

  const material: E2eeDeviceKeyPairMaterial = {
    userPublicId,
    devicePublicId: devicePublicId ?? cryptoObj.randomUUID(),
    keyFingerprint,
    identityPrivateKey: identityPair.privateKey,
    identityPublicKeyJwk,
    signingPrivateKey: signingPair.privateKey,
    signingPublicKeyJwk,
    createdAtIso: new Date().toISOString(),
    isBackupKey: false,
  };

  await saveDeviceKeyMaterial(material, 'primary');
  return material;
}

export function clearMemoryKeystoreForTesting(): void {
  memoryKeystore.clear();
}
