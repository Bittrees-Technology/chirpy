export interface MailCommand {
  action: 'send' | 'status'; service: string; wallet: string; id: string; expiresAt: number;
  to?: string; subject?: string; text?: string;
}
export declare function normalizeMailAddress(value: unknown): string | null;
export declare function mailSignMessage(command: MailCommand): string;
