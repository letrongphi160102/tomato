import { getWebCrypto, utf8ToBytes } from '@/lib/e2ee/utils';

export interface SafetyNumberParticipantInput {
  readonly userPublicId: string;
  readonly keyFingerprints: readonly string[];
}

export interface SafetyNumberResult {
  /** Chuỗi 60 chữ số chia thành 12 nhóm 5 số (ví dụ: `48291 03948 ...`). */
  readonly formatted: string;
  /** Mảng 12 cụm 5 chữ số để hiển thị dạng lưới 3x4 hoặc 4x3 trong mục Thông tin đoạn chat. */
  readonly groups: readonly string[];
}

function normalizeParticipant(input: SafetyNumberParticipantInput): string {
  const userId = input.userPublicId.trim().toLowerCase();
  const sortedFingerprints = Array.from(
    new Set(input.keyFingerprints.map((fp) => fp.trim().toLowerCase()).filter(Boolean)),
  ).sort();
  return `${userId}:${sortedFingerprints.join(',')}`;
}

/**
 * Tính Mã an toàn (Safety Number) 60 chữ số đối xứng giữa 2 người dùng:
 * - Không phụ thuộc thứ tự truyền tham số `(participantA, participantB)` hay `(participantB, participantA)`.
 * - Dùng để kiểm tra chéo trong mục "Thông tin đoạn chat".
 */
export async function computeConversationSafetyNumber(
  participantA: SafetyNumberParticipantInput,
  participantB: SafetyNumberParticipantInput,
): Promise<SafetyNumberResult> {
  const normA = normalizeParticipant(participantA);
  const normB = normalizeParticipant(participantB);
  const ordered = [normA, normB].sort();

  const subtle = getWebCrypto().subtle;
  let digestBytes: Uint8Array<ArrayBuffer> = utf8ToBytes(
    `TOMATO-SAFETY-NUMBER-V1|${ordered[0]}|${ordered[1]}`,
  );

  // Băm lặp 64 vòng SHA-256 để khuếch tán đều trên 12 cụm 5 chữ số.
  for (let i = 0; i < 64; i += 1) {
    const hashBuf = await subtle.digest('SHA-256', digestBytes);
    digestBytes = new Uint8Array(hashBuf);
  }

  const groups: string[] = [];
  // Tạo 12 cụm x 5 chữ số (60 chữ số) từ 24 bytes đầu của digest (mỗi cụm lấy 2 bytes + 1 byte kết hợp).
  for (let groupIdx = 0; groupIdx < 12; groupIdx += 1) {
    const offset = (groupIdx * 2) % (digestBytes.byteLength - 4);
    const value =
      ((digestBytes[offset]! << 24) >>> 0) +
      ((digestBytes[offset + 1]! << 16) >>> 0) +
      ((digestBytes[offset + 2]! << 8) >>> 0) +
      (digestBytes[offset + 3]! >>> 0) +
      groupIdx * 10007;
    const fiveDigits = (value % 100_000).toString(10).padStart(5, '0');
    groups.push(fiveDigits);
  }

  return {
    formatted: groups.join(' '),
    groups,
  };
}
