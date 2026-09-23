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
export type MailDeliveryEventType='sent'|'delivered'|'delivery_delayed'|'failed'|'bounced'|'complained'|'suppressed';
export interface MailDeliveryDetails {version:1;events:{type:MailDeliveryEventType;occurredAt:number}[];}
export declare const MAIL_DELIVERY_EVENTS:readonly MailDeliveryEventType[];
export declare function parseMailDeliveryDetails(value:unknown):MailDeliveryDetails;
