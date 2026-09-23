export type PublicProfile = {version:1;wallet:string;revision:number;label:string|null;updatedAt:number};
export type ProfileCommand = {version:1;service:string;wallet:string;revision:number;label:string|null;expiresAt:number};
export const profileAddress=(value:unknown):value is string=>typeof value==='string'&&/^0x[a-f0-9]{40}$/.test(value);
export const profileLabel=(value:unknown):value is string|null=>value===null||typeof value==='string'&&value===value.trim()&&value.length>0&&value.length<=80&&!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
const exact=(value:unknown,keys:string):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;
export function validPublicProfile(value:unknown,wallet:string):value is PublicProfile {
 return exact(value,'label,revision,updatedAt,version,wallet')&&value.version===1&&value.wallet===wallet&&profileAddress(wallet)&&Number.isSafeInteger(value.revision)&&Number(value.revision)>=0&&Number(value.revision)<Number.MAX_SAFE_INTEGER&&profileLabel(value.label)&&Number.isSafeInteger(value.updatedAt)&&Number(value.updatedAt)>=0&&(value.revision!==0||value.label===null&&value.updatedAt===0);
}
export function validProfileCommand(value:unknown,service:string,now=Date.now()):value is ProfileCommand {
 return exact(value,'expiresAt,label,revision,service,version,wallet')&&value.version===1&&value.service===service&&profileAddress(value.wallet)&&profileLabel(value.label)&&Number.isSafeInteger(value.revision)&&Number(value.revision)>=0&&Number(value.revision)<Number.MAX_SAFE_INTEGER-1&&Number.isSafeInteger(value.expiresAt)&&Number(value.expiresAt)>now&&Number(value.expiresAt)<=now+300000;
}
export function profileSignMessage(command:ProfileCommand){
 return `Chat public profile v1\nService: ${command.service}\nWallet: ${command.wallet}\nCurrent revision: ${command.revision}\nPublic name: ${JSON.stringify(command.label)}\nExpires: ${command.expiresAt}\n${command.label===null?'Withdraw my Chat name. Show my wallet address in Chat.':'Publish this name publicly beside my wallet address in Chat.'}\nThis does not authorize messages, transactions, mailbox access or identity verification.`;
}
