/** Decrypted Push payloads only. No URL fetch, active rendering or identity claim. */
export const PUSH_FILE_BYTES = 1_000_000;
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
