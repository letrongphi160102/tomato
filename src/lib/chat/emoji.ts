/**
 * Tiện ích chuẩn hóa & kiểm tra biểu tượng cảm xúc (Emoji) cho tương tác tin nhắn (M13):
 * - Dùng `Intl.Segmenter(undefined, { granularity: 'grapheme' })` đảm bảo đúng 1 cụm grapheme duy nhất
 *   (hỗ trợ emoji ghép ZWJ, cờ quốc gia, biến thể màu da).
 * - Chặn tuyệt đối chữ cái ASCII/Unicode thường, chữ số thuần, HTML, ký tự điều khiển và ký tự BiDi
 *   (`\u202A–\u202E`, `\u2066–\u2069`, `\u200E–\u200F`, `\u061C`).
 */

export const QUICK_REACTION_EMOJIS = ['❤️', '😂', '😮', '😢', '😡', '👍'] as const;

export interface ChatEmojiCategory {
  readonly id: string;
  readonly label: string;
  readonly emojis: readonly string[];
}

export const CHAT_EMOJI_CATEGORIES: readonly ChatEmojiCategory[] = [
  {
    id: 'smileys',
    label: 'Cảm xúc',
    emojis: [
      '😀',
      '😃',
      '😄',
      '😁',
      '😆',
      '🥹',
      '😅',
      '😂',
      '🤣',
      '😊',
      '😇',
      '🙂',
      '😉',
      '😌',
      '😍',
      '🥰',
      '😘',
      '😋',
      '😜',
      '🤪',
      '😎',
      '🥳',
      '🤩',
      '😏',
      '😮',
      '🥺',
      '😢',
      '😭',
      '😤',
      '😡',
      '🤔',
      '😴',
    ],
  },
  {
    id: 'hearts',
    label: 'Yêu thích',
    emojis: [
      '❤️',
      '🧡',
      '💛',
      '💚',
      '💙',
      '💜',
      '🤍',
      '💖',
      '💗',
      '💓',
      '💞',
      '💕',
      '✨',
      '🔥',
      '🌟',
      '🎉',
      '🎊',
      '💯',
      '🌹',
      '🌸',
    ],
  },
  {
    id: 'gestures',
    label: 'Cử chỉ',
    emojis: [
      '👍',
      '👎',
      '👏',
      '🙌',
      '🤝',
      '🙏',
      '💪',
      '👋',
      '✌️',
      '🤞',
      '🤟',
      '👌',
      '🫶',
      '🫡',
      '👀',
    ],
  },
];

export const MAX_REACTION_EMOJI_LENGTH = 32;

const FORBIDDEN_EMOJI_CHAR_REGEX =
  /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C<>"'`\\/]/;
const PLAIN_ALNUM_OR_SPACE_REGEX = /[A-Za-z0-9\s]/;
const KEYCAP_EMOJI_REGEX = /^[#*0-9]\uFE0F?\u20E3$/;
const EXTENDED_PICTOGRAPHIC_OR_FLAG_REGEX =
  /(?:\p{Extended_Pictographic}|(?:\p{Regional_Indicator}\p{Regional_Indicator}))/u;

const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

export function normalizeAndValidateSingleEmoji(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REACTION_EMOJI_LENGTH) {
    return null;
  }

  if (FORBIDDEN_EMOJI_CHAR_REGEX.test(trimmed)) {
    return null;
  }

  const isKeycapEmoji = KEYCAP_EMOJI_REGEX.test(trimmed);
  if (!isKeycapEmoji) {
    if (PLAIN_ALNUM_OR_SPACE_REGEX.test(trimmed)) {
      return null;
    }
    if (!EXTENDED_PICTOGRAPHIC_OR_FLAG_REGEX.test(trimmed)) {
      return null;
    }
  }

  if (graphemeSegmenter) {
    const segments = Array.from(graphemeSegmenter.segment(trimmed));
    if (segments.length !== 1) {
      return null;
    }
  } else {
    // Fallback môi trường không có Intl.Segmenter: giới hạn code points tối đa cho 1 emoji ghép.
    const codePoints = Array.from(trimmed);
    if (codePoints.length > 10) {
      return null;
    }
  }

  return trimmed;
}

export function isValidSingleReactionEmoji(raw: unknown): boolean {
  return normalizeAndValidateSingleEmoji(raw) !== null;
}
