const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const usedIds = new Set<string>();

export function createNodeId(prefix: string): string {
  const bytes = new Uint8Array(13);
  let id: string;
  do {
    crypto.getRandomValues(bytes);
    id = `${prefix}-${Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("")}`;
  } while (usedIds.has(id));
  usedIds.add(id);
  return id;
}

export function reserveNodeId(id: string): void {
  if (id) usedIds.add(id);
}
