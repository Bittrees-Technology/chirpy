export const MAIL_ATTACHMENT_BYTES=262144;
export const MAIL_ATTACHMENT_COUNT=4;
export type OutgoingAttachment={filename:string;content:string};
export function validAttachmentName(value:unknown):value is string{
 return typeof value==='string'&&value.length>0&&value.length<=120&&value===value.trim()&&value!=='.'&&value!=='..'&&!Array.from(value).some(c=>c.length===1&&/[\ud800-\udfff]/.test(c))&&new TextEncoder().encode(value).length<=240&&!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069/\\]/.test(value);
}
export function validOutgoingAttachments(value:unknown):value is OutgoingAttachment[]{
 if(!Array.isArray(value)||value.length>MAIL_ATTACHMENT_COUNT)return false;
 let total=0;
 for(const file of value){
  if(!file||typeof file!=='object'||Array.isArray(file)||Object.keys(file).sort().join(',')!=='content,filename'||!validAttachmentName(file.filename)||typeof file.content!=='string'||file.content.length>349528||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))return false;
  try{const decoded=atob(file.content);if(btoa(decoded)!==file.content)return false;total+=decoded.length;}catch{return false;}
  if(total>MAIL_ATTACHMENT_BYTES)return false;
 }return true;
}
