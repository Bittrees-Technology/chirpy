// Shared offline/runtime configuration validation. No network or secret output.
const address=v=>typeof v==='string'&&/^0x[a-f0-9]{40}$/.test(v);
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function connectedMailConfig(env=process.env,{allowDisabled=false}={}){
 if((env.CHAT_CONNECTED_MAIL_ENABLED!=='1'&&!allowDisabled)||(env.VERCEL_ENV&&env.VERCEL_ENV!=='production'))return null;
 try{
  const url=new URL(env.KV_REST_API_URL||env.UPSTASH_REDIS_REST_URL),key=env.CHAT_CONNECTED_MAIL_KEY,kvToken=env.KV_REST_API_TOKEN||env.UPSTASH_REDIS_REST_TOKEN;
  const testWallets=String(env.CHAT_CONNECTED_MAIL_TEST_WALLETS||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
  if(testWallets.some(v=>!address(v)))return null;
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!hex(key)||!kvToken)return null;
  return {kvUrl:url.href,kvToken,key:Buffer.from(key,'hex'),prefix:'chat:connected-mail:v1:',testWallets,rpc:env.MAINNET_RPC_URL||''};
 }catch{return null;}
}
