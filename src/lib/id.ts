let fallbackId = 0;

export function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  fallbackId += 1;
  return `${prefix}-${Date.now()}-${fallbackId}`;
}
