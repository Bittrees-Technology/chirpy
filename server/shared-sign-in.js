import {createSsoClient,readCookie,nodeRequest,nodeResponse} from '../shared/sso/client.mjs';
import {connectedMailConfig,createConnectedMail,ConnectedMailError,CHAT_ORIGIN} from './connected-mail.js';
export function chatMailSsoAdapter(service){return {
 async current(req){
  const token=readCookie(req,'chat_mail_session',CHAT_ORIGIN);if(!token)return null;
  try{return await service.sharedIdentity(token);}catch(e){if(e instanceof ConnectedMailError&&e.status===401)return null;throw e;}
 },
 async establish(wallet,authTime,req){
  const result=await service.establishSharedIdentity(wallet,authTime,readCookie(req,'chat_mail_session',CHAT_ORIGIN));
  return {key:result.token,cookies:[`__Host-chat_mail_session=${result.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.max(0,Math.floor((result.expiresAt-Date.now())/1000))}`]};
 }
};}
export function chatSsoHandler({env=process.env,service,fetcher=fetch}={}){
 const config=connectedMailConfig(env),enabled=env.BITTREES_SSO_ENABLED==='1'&&!!config;
 const adapter=chatMailSsoAdapter(service||(config?createConnectedMail(config):{}));
 return createSsoClient({clientId:'chat',cookiePrefix:'bt-sso-chat',origin:CHAT_ORIGIN,issuer:'https://roles.bittrees.org',secret:env.BITTREES_SSO_CLIENT_SECRET,enabled,adapter,fetcher});
}
export default async function handler(req,res){
 if(req.headers?.host!=='chat.bittrees.org'){res.setHeader('Cache-Control','no-store');return res.status(403).json({error:'Use chat.bittrees.org for shared sign-in.'});}
 return nodeResponse(await chatSsoHandler()(await nodeRequest(req,CHAT_ORIGIN)),res);
}
