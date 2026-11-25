export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export function generateRoomCode(rng: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = Math.min(ROOM_CODE_ALPHABET.length - 1, Math.floor(rng() * ROOM_CODE_ALPHABET.length));
    out += ROOM_CODE_ALPHABET[idx];
  }
  return out;
}

export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidRoomCode(input: string): boolean {
  if (input.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of input) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}
