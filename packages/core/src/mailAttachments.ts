export const MAIL_ATTACHMENT_BYTES=1048576;
export const MAIL_ATTACHMENT_COUNT=4;
export type OutgoingAttachment={filename:string;content:string};
export function validAttachmentName(value:unknown):value is string{
 return typeof value==='string'&&value.length>0&&value.length<=120&&value===value.trim()&&value!=='.'&&value!=='..'&&!Array.from(value).some(c=>c.length===1&&/[\ud800-\udfff]/.test(c))&&new TextEncoder().encode(value).length<=240&&!/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069/\\]/.test(value);
}
export function validOutgoingAttachments(value:unknown,maximum=MAIL_ATTACHMENT_BYTES):value is OutgoingAttachment[]{
 if(!Array.isArray(value)||value.length>MAIL_ATTACHMENT_COUNT)return false;
 let total=0;
 for(const file of value){
  if(!file||typeof file!=='object'||Array.isArray(file)||Object.keys(file).sort().join(',')!=='content,filename'||!validAttachmentName(file.filename)||typeof file.content!=='string'||file.content.length>4*Math.ceil(maximum/3))return false;
  try{const decoded=atob(file.content);if(btoa(decoded)!==file.content)return false;total+=decoded.length;}catch{return false;}
  if(total>maximum)return false;
 }return true;
}
