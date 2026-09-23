/** Decrypted Push payloads only. No URL fetch, active rendering or identity claim. */
export const PUSH_FILE_BYTES = 1_000_000;
// Six maximum-size files encode below the existing 8 MiB history-page budget.
export const PUSH_MAX_FILES = 6;
const MAX_CONTENT = 1_340_000;
export interface PushAttachment { filename: string; mediaType: string; bytes: number; base64: string }
function filename(value: unknown, fallback: string) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f/\\:*?"<>|]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120) || fallback;
}
export function readPushAttachment(type: unknown, content: unknown): PushAttachment | undefined {
  if (!['Image', 'File', 'Audio', 'Video'].includes(type as string) || typeof content !== 'string' || content.length > MAX_CONTENT) return;
  let data = content, name: unknown;
  if (type === 'File' && content.startsWith('{')) {
    let file: unknown; try { file = JSON.parse(content); } catch { return; }
    if (!file || typeof file !== 'object' || Array.isArray(file)) return;
    const record = file as Record<string, unknown>;
    if (typeof record.content !== 'string') return;
    data = record.content; name = record.name;
  }
  const match = /^data:([a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(data);
  if (!match) return;
  const mediaType = match[1].toLowerCase(), base64 = match[2];
  if (mediaType.length > 127) return;
  if (base64.length % 4) return;
  const bytes = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (bytes < 0 || bytes > PUSH_FILE_BYTES) return;
  try { if (btoa(atob(base64)) !== base64) return; } catch { return; }
  if (type !== 'File' && !mediaType.startsWith(String(type).toLowerCase() + '/')) return;
  const extension: Record<string, string> = { 'image/png':'png', 'image/jpeg':'jpg', 'image/gif':'gif', 'image/webp':'webp', 'audio/mpeg':'mp3', 'audio/ogg':'ogg', 'video/mp4':'mp4', 'application/pdf':'pdf', 'text/plain':'txt' };
  return { filename: filename(name, 'push-attachment.' + (extension[mediaType] ?? 'bin')), mediaType, bytes, base64 };
}
/** Preserve the exact external destination; never create an embedded preview. */
export function readPushMediaLink(content: unknown): string | undefined {
  if (typeof content !== 'string' || content.length > 2048 || !/^https:\/\//i.test(content) || /[\\\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(content)) return;
  try { const url = new URL(content); if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return url.href; } catch { /* unsupported */ }
}

/** Prepare a user-selected file without interpreting its contents. */
export function preparePushFile(name: string, type: string, bytes: Uint8Array): PushAttachment {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > PUSH_FILE_BYTES) throw new Error('Choose a file of at most 1 MB.');
  const mediaType = type.length <= 127 && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type) ? type.toLowerCase() : 'application/octet-stream';
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { filename: filename(name, 'attachment.bin'), mediaType, bytes: bytes.byteLength, base64: btoa(binary) };
}
/** Snapshot and revalidate at dispatch; never trust UI size or MIME claims. */
export function writePushFile(file: PushAttachment): string {
  if (!file || typeof file !== 'object' || typeof file.filename !== 'string' || typeof file.mediaType !== 'string'
    || typeof file.base64 !== 'string' || file.base64.length > MAX_CONTENT) throw new Error('The selected file is invalid. Choose it again.');
  const content = JSON.stringify({ name: file.filename, content: `data:${file.mediaType};base64,${file.base64}` });
  const parsed = readPushAttachment('File', content);
  if (!parsed || parsed.bytes !== file.bytes || parsed.filename !== file.filename || parsed.mediaType !== file.mediaType) throw new Error('The selected file is invalid. Choose it again.');
  return content;
}

/** Validate the whole selection before authority checks or a network write. */
export function writePushFiles(files: PushAttachment[]): string[] {
  if (!Array.isArray(files) || files.length > PUSH_MAX_FILES) throw new Error('Choose at most 6 files, up to 1 MB each.');
  // Array.from visits holes too, so sparse or partially invalid batches fail closed.
  return Array.from(files, writePushFile);
}
