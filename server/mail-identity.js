import {walletAccessConfig,walletServiceHeaders} from './wallet-service-access.js';
// Server-only Wallet consumer. Never trust a browser-supplied binding reference.
export function mailIdentityConfig(env) {
  const url=env.CHIRPY_MAIL_IDENTITY_URL, credential=env.CHIRPY_MAIL_IDENTITY_SECRET;
  const origin=env.CHIRPY_MAIL_IDENTITY_ACCESS_ORIGIN,secret=env.CHIRPY_MAIL_IDENTITY_ACCESS_SECRET;
  if(!url&&!credential&&!origin&&!secret)return null;
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/api/service/delivery'||typeof credential!=='string'||credential.length<32)throw Error('Invalid Wallet identity configuration');
  const access=walletAccessConfig(u.href,credential,origin,secret);
  const config={url:u.href,credential,...(access?{access}:{})};
  walletServiceHeaders(config,'/api/service/delivery');
  return config;
}
export function mailIdentityScope(binding,wallet,deliveryId,contentHash){
  const identity=binding?.identity;
  if(!identity||typeof identity.bindingId!=='string'||!identity.bindingId||identity.bindingId.length>128||!Number.isSafeInteger(identity.version)||identity.version<1)return null;
  return {bindingId:identity.bindingId,expectedVersion:identity.version,senderWallet:wallet,deliveryId,contentHash};
}
export async function resolveMailIdentity(config,scope,email,request=fetch){
  if(!config||!scope)return false;
  const response=await request(config.url,{method:'POST',redirect:'error',credentials:'omit',headers:walletServiceHeaders(config,'/api/service/delivery'),body:JSON.stringify(scope),signal:AbortSignal.timeout(5000)});
  if(!response.ok){if([400,401,403,404,409,410].includes(response.status))return false;throw Error('Wallet authorization unavailable');}
  // Bound the body before parsing, including when Content-Length is missing.
  const reader=response.body?.getReader();if(!reader)throw Error('Invalid Wallet authorization response');
  let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096)throw Error('Wallet authorization response too large');chunks.push(Buffer.from(value));}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return result?.bindingId===scope.bindingId&&result.version===scope.expectedVersion&&result.senderWallet===scope.senderWallet&&result.deliveryId===scope.deliveryId&&result.contentHash===scope.contentHash&&result.email===email&&Number.isSafeInteger(result.expiresAt)&&result.expiresAt>Date.now()&&result.expiresAt<=Date.now()+23*3600000;
}
