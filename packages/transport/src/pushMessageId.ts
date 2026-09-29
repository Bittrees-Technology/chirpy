/** Exact supported Push references: legacy CID tokens and v2 message hashes.
 * Preserve the wire value unchanged for pagination, replies and reactions. */
export function isPushMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && (/^[a-zA-Z0-9]{10,128}$/.test(value) || /^v2:[0-9a-f]{64}$/.test(value));
}
