// O, 0, I, 1, S, 5, 8, B excluded — read off a phone screen in a dark room.
const ALPHABET = "ACDEFGHJKLMNPQRTUVWXY234679";
const CODE_LENGTH = 4;

export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return code;
}
