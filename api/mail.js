import { syncCors } from '../server/sync-cors.js';
import { checkRateLimit } from '../server/server-utils.js';
import { mailConfig, createMailService, verifyMailCommand } from '../server/mail-service.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
  const config=mailConfig();
  if (!config) return res.status(503).json({enabled:false,error:'Wallet email is not configured.'});
  const cors=syncCors(req,res,{service:config.service,allowedOrigins:process.env.CHIRPY_MAIL_ALLOWED_ORIGINS||''});
  if(cors) return res.status(cors.status).json(cors.body);
  if(req.method==='GET') return res.status(200).json({enabled:true,service:config.service,authVersion:1});
  if(req.method!=='POST') {res.setHeader('Allow','GET, POST, OPTIONS');return res.status(405).json({error:'Method not allowed.'});}
  const rate=checkRateLimit(req,'/api/mail');
  if(!rate.allowed) return res.status(429).json({error:'Too many requests.'});
  if(String(req.headers?.['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json') return res.status(415).json({error:'Use application/json.'});
  try {
    if(Buffer.byteLength(JSON.stringify(req.body||{}))>100000) return res.status(413).json({error:'Message is too large.'});
    const {command,signature}=req.body||{};
    if(!await verifyMailCommand(command,signature,config.service)) return res.status(401).json({error:'Invalid or expired wallet authorization.'});
    const result=await createMailService(config).execute(command);
    const status={denied:403,conflict:409,limited:429,expired:401}[result.status]||200;
    return res.status(status).json(result);
  } catch {return res.status(503).json({error:'Email service unavailable. Keep this request ID and check its status before composing another message.'});}
}
