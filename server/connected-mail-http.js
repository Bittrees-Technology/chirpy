import {connectedMailConfig,createConnectedMail,ConnectedMailError,exactMailInput,connectionCookieAge,CHAT_ORIGIN,MAIL_ORIGIN} from './connected-mail.js';
import {checkRateLimit} from './server-utils.js';
const cookieName=kind=>'__Host-chat_mail_'+kind;
function cookie(req,kind){const values=String(req.headers?.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(cookieName(kind)+'='));return values.length===1?values[0].slice(cookieName(kind).length+1):'';}
const setCookie=(kind,token,seconds)=>`${cookieName(kind)}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`;
export function createConnectedMailHandler({config=action=>connectedMailConfig(process.env,{allowDisabled:action==='disconnect'}),service=c=>createConnectedMail(c),rate=checkRateLimit}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
  try{
   const action=req.query?.action;
   if(!['challenge','verify','start','callback','status','operation','disconnect'].includes(action))return res.status(404).json({error:'Not found.'});
   if(req.headers?.host!=='chat.bittrees.org')throw new ConnectedMailError(403,'Use chat.bittrees.org to connect Mail.');
   if(req.method!==(action==='status'?'GET':'POST')){res.setHeader('Allow',action==='status'?'GET':'POST');return res.status(405).json({error:'Method not allowed.'});}
   if(req.headers?.authorization)throw new ConnectedMailError(400,'Use the Chat browser session.');
   const origin=req.headers?.origin;
   if((req.method==='POST'&&origin!==(action==='callback'?MAIL_ORIGIN:CHAT_ORIGIN))||(req.method==='GET'&&origin&&origin!==CHAT_ORIGIN))throw new ConnectedMailError(403,'Request origin is not allowed.');
   if(!rate(req,'/api/mail/'+action).allowed)throw new ConnectedMailError(429,'Too many mail requests.');
   const c=config(action);if(!c)return res.status(503).json({enabled:false,error:'Connected Mail is not available yet.'});
   const api=service(c),session=cookie(req,'session');
   if(action==='status'){
    if(typeof req.query?.wallet!=='string')throw new ConnectedMailError(400,'Choose your connected wallet.');
    const status=await api.status(session,req.query.wallet);
    if(status.connection)res.setHeader('Set-Cookie',setCookie('session',session,connectionCookieAge(status.connection)));
    return res.status(200).json({enabled:true,...status});
   }
   const type=String(req.headers?.['content-type']||'').split(';')[0].trim().toLowerCase();
   if(type!==(action==='callback'?'application/x-www-form-urlencoded':'application/json'))throw new ConnectedMailError(415,'Invalid request format.');
   if(Buffer.byteLength(typeof req.body==='string'?req.body:JSON.stringify(req.body??{}))>65536)throw new ConnectedMailError(413,'Mail request is too large.');
   let input=req.body;
   if(action==='callback'&&typeof input==='string'){
    const params=new URLSearchParams(input);input={};for(const [key,value]of params){if(Object.hasOwn(input,key))throw new ConnectedMailError(400,'Duplicate callback field.');Object.defineProperty(input,key,{value,enumerable:true});}
   }
   if(action==='challenge'){
    exactMailInput(input,['wallet']);const challenge=await api.challenge(input.wallet);
    res.setHeader('Set-Cookie',setCookie('challenge',challenge.token,300));return res.status(200).json({message:challenge.message});
   }
   if(action==='verify'){
    // A fresh explicit disconnect avoids leaving an old mailbox connection behind.
    if(session)throw new ConnectedMailError(409,'Disconnect the existing Mail session before signing in again.');
    const result=await api.verify(cookie(req,'challenge'),input);
    res.setHeader('Set-Cookie',[setCookie('challenge','',0),setCookie('session',result.token,3600)]);return res.status(200).json({wallet:result.wallet,expiresAt:result.expiresAt});
   }
   if(action==='start'){exactMailInput(input,['wallet']);if(typeof input.wallet!=='string')throw new ConnectedMailError(400,'Choose your connected wallet.');return res.status(200).json(await api.start(session,input.wallet));}
   if(action==='callback'){
    const connection=await api.callback(session,input);res.setHeader('Set-Cookie',setCookie('session',session,connectionCookieAge(connection)));res.setHeader('Location',CHAT_ORIGIN+'/?mail=connected');return res.status(303).end();
   }
   if(action==='operation'){const result=await api.operation(session,input);const status=await api.status(session,input.wallet);if(status.connection)res.setHeader('Set-Cookie',setCookie('session',session,connectionCookieAge(status.connection)));return res.status(200).json(result);}
   exactMailInput(input,[]);const result=/^[a-f0-9]{64}$/.test(session)?await api.disconnect(session):{ok:true,sourceRevoked:true};
   res.setHeader('Set-Cookie',setCookie('session','',0));return res.status(200).json(result);
  }catch(e){return res.status(e instanceof ConnectedMailError?e.status:503).json({error:e instanceof ConnectedMailError?e.message:'Mail connection is unavailable. If sending, check Sent before retrying.'});}
 };
}
