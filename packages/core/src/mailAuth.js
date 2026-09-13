export function normalizeMailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\x00-\x20\x7f]/.test(value)) return null;
  const parts = value.split('@');
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[a-zA-Z0-9!#$&'*+\-/=^_`{|}~]+(?:\.[a-zA-Z0-9!#$&'*+\-/=^_`{|}~]+)*$/.test(local)) return null;
  if (!domain.includes('.') || !domain.split('.').every(p => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(p))) return null;
  return `${local}@${domain.toLowerCase()}`;
}
export function mailSignMessage(command) {
  const lines = ['Chirpy wallet-to-email v1', `Service: ${command.service}`, `Action: ${command.action}`, `Wallet: ${command.wallet}`, `Request: ${command.id}`, `Signature expires: ${command.expiresAt}`];
  if (command.action === 'send') lines.push(`Recipient: ${command.to}`, `Subject: ${command.subject}`, 'Authorize this email and queue retries for up to 23 hours. The email provider can read it. No blockchain transaction.', 'Message:', command.text);
  return lines.join('\n');
}
