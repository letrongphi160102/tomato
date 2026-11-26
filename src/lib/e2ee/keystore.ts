import type { E2eeDeviceKeyPairMaterial, E2eePrivateJwk, E2eePublicJwk } from '@/lib/e2ee/types';
import {
  computeDeviceKeyFingerprint,
  getWebCrypto,
  normalizePublicP256Jwk,
} from '@/lib/e2ee/utils';

const IDB_DATABASE_NAME = 'tomato_e2ee_keystore_v1';
const IDB_STORE_NAME = 'device_keys';
const IDB_VERSION = 1;

// Bộ nhớ đệm đọc xuyên suốt (read-through RAM cache) + fallback khi IndexedDB không khả dụng.
// Lưu ý bảo mật: `CryptoKey` riêng tư luôn có `extractable: false`, tuyệt đối không ghi ra localStorage/sessionStorage.
const memoryKeystore = new Map<string, E2eeDeviceKeyPairMaterial>();
let sharedDbPromise: Promise<IDBDatabase> | null = null;

function buildStoreKey(userPublicId: string, slotOrFingerprint: string): string {
  return `${userPublicId.toLowerCase()}:${slotOrFingerprint.toLowerCase()}`;
}

function isIndexedDbAvailable(): boolean {
  return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
}

function getSharedKeystoreDb(): Promise<IDBDatabase> {
  if (sharedDbPromise) {
    return sharedDbPromise;
  }

  sharedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(IDB_DATABASE_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        sharedDbPromise = null;
        try {
          db.close();
        } catch {
          // Bỏ qua nếu kết nối đã đóng.
        }
      };
      db.onclose = () => {
        sharedDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      sharedDbPromise = null;
      reject(request.error ?? new Error('Không thể mở IndexedDB'));
    };
  });

  return sharedDbPromise;
}

async function idbGet(key: string): Promise<E2eeDeviceKeyPairMaterial | null> {
  const cachedInRam = memoryKeystore.get(key);
  if (cachedInRam) {
    return cachedInRam;
  }
  if (!isIndexedDbAvailable()) {
    return null;
  }
  try {
    const db = await getSharedKeystoreDb();
    const found = await new Promise<E2eeDeviceKeyPairMaterial | null>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const store = tx.objectStore(IDB_STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        resolve((req.result as E2eeDeviceKeyPairMaterial | undefined) ?? null);
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
    if (found) {
      memoryKeystore.set(key, found);
    }
    return found;
  } catch {
    sharedDbPromise = null;
    return memoryKeystore.get(key) ?? null;
  }
}

async function idbPut(key: string, value: E2eeDeviceKeyPairMaterial): Promise<void> {
  memoryKeystore.set(key, value);
  if (!isIndexedDbAvailable()) {
    return;
  }
  try {
    const db = await getSharedKeystoreDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_STORE_NAME);
      const req = store.put(value, key);
      req.onsuccess = () => {
        resolve();
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  } catch {
    sharedDbPromise = null;
    // Đã lưu trong memoryKeystore làm fallback an toàn.
  }
}

/**
 * Lưu một cặp khóa thiết bị (hoặc khóa khôi phục từ mã PIN / bootstrap) đã ở trạng thái `extractable: false`
 * vào IndexedDB theo cả slot (`primary` / `backup` / `bootstrap`) và `keyFingerprint`.
 */
export async function saveDeviceKeyMaterial(
  material: E2eeDeviceKeyPairMaterial,
  slot: 'primary' | 'backup' | 'bootstrap' = 'primary',
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

export async function getBootstrapDeviceKeyMaterial(
  userPublicId: string,
): Promise<E2eeDeviceKeyPairMaterial | null> {
  return idbGet(buildStoreKey(userPublicId, 'bootstrap'));
}

export async function getDeviceKeyMaterialByFingerprint(
  userPublicId: string,
  keyFingerprint: string,
): Promise<E2eeDeviceKeyPairMaterial | null> {
  return idbGet(buildStoreKey(userPublicId, keyFingerprint));
}

/**
 * Nạp cặp khóa khởi tạo hộp thư mặc định (Pre-Key Bootstrap) vào IndexedDB với `extractable: false`
 * và xóa sạch thành phần khóa riêng `d` trong RAM để giải mã được các tin nhắn gửi đến lúc tài khoản ngoại tuyến.
 */
export async function importAndStoreBootstrapKeyMaterial(
  userPublicId: string,
  bundle: {
    readonly keyFingerprint: string;
    readonly identityPublicKeyJwk: E2eePublicJwk;
    readonly identityPrivateJwk: E2eePrivateJwk;
    readonly signingPublicKeyJwk: E2eePublicJwk;
    readonly signingPrivateJwk: E2eePrivateJwk;
  },
): Promise<E2eeDeviceKeyPairMaterial> {
  const existing = await getBootstrapDeviceKeyMaterial(userPublicId);
  if (existing && existing.keyFingerprint === bundle.keyFingerprint) {
    bundle.identityPrivateJwk.d = '';
    bundle.signingPrivateJwk.d = '';
    return existing;
  }

  const cryptoObj = getWebCrypto();
  const subtle = cryptoObj.subtle;
  const idPub = normalizePublicP256Jwk(bundle.identityPublicKeyJwk);
  const sigPub = normalizePublicP256Jwk(bundle.signingPublicKeyJwk);

  const [identityPrivateKey, signingPrivateKey] = await Promise.all([
    subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: idPub.x,
        y: idPub.y,
        d: bundle.identityPrivateJwk.d,
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false, // extractable: false
      ['deriveBits'],
    ),
    subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: sigPub.x,
        y: sigPub.y,
        d: bundle.signingPrivateJwk.d,
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, // extractable: false
      ['sign'],
    ),
  ]);

  bundle.identityPrivateJwk.d = '';
  bundle.signingPrivateJwk.d = '';

  const material: E2eeDeviceKeyPairMaterial = {
    userPublicId,
    devicePublicId: cryptoObj.randomUUID(),
    keyFingerprint: bundle.keyFingerprint,
    identityPrivateKey,
    identityPublicKeyJwk: idPub,
    signingPrivateKey,
    signingPublicKeyJwk: sigPub,
    createdAtIso: new Date().toISOString(),
    isBackupKey: true,
  };

  await saveDeviceKeyMaterial(material, 'bootstrap');
  return material;
}

/**
 * Lấy toàn bộ các khóa giải mã hiện có của người dùng trên trình duyệt này
 * (bao gồm khóa thiết bị chính, khóa hộp thư mặc định và khóa đồng bộ từ mã PIN nếu có).
 */
export async function listLocalDeviceKeyMaterials(
  userPublicId: string,
): Promise<E2eeDeviceKeyPairMaterial[]> {
  const [primary, bootstrap, backup] = await Promise.all([
    getPrimaryDeviceKeyMaterial(userPublicId),
    getBootstrapDeviceKeyMaterial(userPublicId),
    getBackupDeviceKeyMaterial(userPublicId),
  ]);
  const map = new Map<string, E2eeDeviceKeyPairMaterial>();
  if (primary) {
    map.set(primary.keyFingerprint, primary);
  }
  if (bootstrap) {
    map.set(bootstrap.keyFingerprint, bootstrap);
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

export function clearInMemoryKeystore(): void {
  memoryKeystore.clear();
}

export function clearMemoryKeystoreForTesting(): void {
  clearInMemoryKeystore();
}
