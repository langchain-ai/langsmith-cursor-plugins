export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}
