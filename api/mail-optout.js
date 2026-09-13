import { mailConfig, optOutMail } from '../server/mail-service.js';
import { checkRateLimit } from '../server/server-utils.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.method!=='POST')return res.status(405).json({error:'Use POST.'});
  // Recipient opt-out stays available when outbound sending is paused.
  const config=mailConfig({...process.env,CHIRPY_MAIL_ENABLED:'1'});
  if(!config)return res.status(503).json({error:'Email preferences are unavailable.'});
  const origin=req.headers?.origin;
  if(origin && origin!==new URL(config.service).origin)return res.status(403).json({error:'Use the email preference page.'});
  if(!checkRateLimit(req,'/api/mail-optout').allowed)return res.status(429).json({error:'Please wait and try again.'});
  if(String(req.headers?.['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')return res.status(415).json({error:'Use JSON.'});
  const body=req.body;
  if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==1 || typeof body.token!=='string' || !/^[a-f0-9]{64}$/.test(body.token))return res.status(400).json({error:'Invalid preference link.'});
  try {
    const result=await optOutMail(config,body.token);
    return res.status(result.status==='opted-out'?200:404).json(result);
  } catch {return res.status(503).json({error:'Could not confirm the change. Please try again.'});}
}
