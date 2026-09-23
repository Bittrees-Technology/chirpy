export interface MailCommand {
  action: 'send' | 'status'; service: string; wallet: string; id: string; expiresAt: number;
  to?: string; subject?: string; text?: string;
}
export declare function normalizeMailAddress(value: unknown): string | null;
export interface MailHistoryCommand {
  action: 'history'; service: string; wallet: string; id: string; expiresAt: number; cursor: string | null;
}
export declare function mailSignMessage(command: MailCommand | MailHistoryCommand): string;
export interface MailReceiptDetails {
  version: 1; createdAt: number; updatedAt: number | null; attempts: number; retryUntil: number;
}
export declare function parseMailReceiptDetails(value: unknown, status: string): MailReceiptDetails;
