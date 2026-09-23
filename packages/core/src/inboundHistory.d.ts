export declare const INBOUND_HISTORY_SERVICE:'https://chat.bittrees.org/api/mail/inbound-history';
export interface InboundHistoryCommand {action:'history';service:string;wallet:string;id:string;cursor:string|null;expiresAt:number;}
export interface InboundHistoryRecord {id:string;status:'queued'|'sending'|'published'|'uncertain'|'stopped';createdAt:number;updatedAt:number|null;deadline:number;attempts:number;}
export declare function validInboundHistoryCommand(value:unknown,now?:number):value is InboundHistoryCommand;
export declare function inboundHistorySignMessage(command:InboundHistoryCommand):string;
export declare function parseInboundHistoryRecord(value:unknown):InboundHistoryRecord;
