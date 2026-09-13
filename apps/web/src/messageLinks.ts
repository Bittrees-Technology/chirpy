export interface MessagePart { text: string; href?: string }

/** Linkify explicit HTTPS text only. No fetching, HTML parsing or URL decoding. */
export function messageParts(body: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let cursor = 0;
  let links = 0;
  for (const match of body.matchAll(/(^|[\s(])https:\/\/[^\s<>"']+/gi)) {
    if (links >= 100) break;
    const start = match.index! + match[1].length;
    let text = match[0].slice(match[1].length);
    if (text.length > 2048) continue;
    text = text.replace(/[.,!?;:]+$/, "");
    // A closing sentence parenthesis is punctuation; balanced URL parentheses stay.
    while (text.endsWith(")") && (text.match(/\)/g)?.length ?? 0) > (text.match(/\(/g)?.length ?? 0)) text = text.slice(0, -1);
    if (text.length > 2048 || /[\\\u0000-\u0020\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/.test(text) || /%(?![0-9a-f]{2})/i.test(text)) continue;
    let url: URL;
    try { url = new URL(text); } catch { continue; }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) continue;
    if (start > cursor) parts.push({ text: body.slice(cursor, start) });
    parts.push({ text, href: url.href });
    links++;
    cursor = start + text.length;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts;
}
