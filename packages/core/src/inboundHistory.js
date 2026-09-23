export const INBOUND_HISTORY_SERVICE='https://chat.bittrees.org/api/mail/inbound-history';
const hex=(value,length)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`).test(value);
export function validInboundHistoryCommand(c,now=Date.now()){
 return !!c&&Object.keys(c).sort().join(',')==='action,cursor,expiresAt,id,service,wallet'&&c.action==='history'&&c.service===INBOUND_HISTORY_SERVICE&&typeof c.wallet==='string'&&/^0x[a-f0-9]{40}$/.test(c.wallet)&&hex(c.id,32)&&(c.cursor===null||hex(c.cursor,64))&&Number.isSafeInteger(c.expiresAt)&&c.expiresAt>now&&c.expiresAt<=now+300000;
}
export function inboundHistorySignMessage(c){return ['Chat incoming forwarding history v1',`Service: ${c.service}`,`Wallet: ${c.wallet}`,`Request: ${c.id}`,`Before: ${c.cursor??'first page'}`,`Signature expires: ${c.expiresAt}`,'Read up to 25 retained incoming forwarding statuses originally authorized for this wallet. This does not authorize mailbox access, messages, retries, transactions, or account changes.'].join('\n');}
export function parseInboundHistoryRecord(value){
 const time=n=>Number.isSafeInteger(n)&&n>0&&n<=8640000000000000;
 if(!value||Object.keys(value).sort().join(',')!=='attempts,createdAt,deadline,id,status,updatedAt'||!hex(value.id,64)||!['queued','sending','published','uncertain','stopped'].includes(value.status)||!time(value.createdAt)||!time(value.deadline)||value.deadline<=value.createdAt||value.deadline>value.createdAt+82830000||!(value.updatedAt===null||time(value.updatedAt)&&value.updatedAt>=value.createdAt)||!Number.isSafeInteger(value.attempts)||value.attempts<0||['sending','published','uncertain'].includes(value.status)&&value.attempts===0)throw Error('Invalid incoming forwarding receipt.');
 return {id:value.id,status:value.status,createdAt:value.createdAt,updatedAt:value.updatedAt,deadline:value.deadline,attempts:value.attempts};
}
