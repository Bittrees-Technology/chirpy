import {inboundMailConfig} from './inbound-mail.js';
import {verifyInboundHistoryCommand,readInboundHistory} from './inbound-history.js';
import {INBOUND_HISTORY_SERVICE} from '../packages/core/src/inboundHistory.js';
import {syncCors} from './sync-cors.js';
import {checkRateLimit} from './server-utils.js';
export default async function inboundHistoryHandler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 const config=inboundMailConfig();if(!config)return res.status(503).json({enabled:false,error:'Incoming forwarding history is not configured.'});
 const cors=syncCors(req,res,{service:INBOUND_HISTORY_SERVICE,allowedOrigins:process.env.CHAT_MAIL_INBOUND_HISTORY_ALLOWED_ORIGINS||''});if(cors)return res.status(cors.status).json(cors.body);
 if(req.method==='GET')return res.status(200).json({enabled:true,service:INBOUND_HISTORY_SERVICE,version:1});
 if(req.method!=='POST'){res.setHeader('Allow','GET, POST, OPTIONS');return res.status(405).json({error:'Use POST.'});}
 if(!checkRateLimit(req,'/api/mail/inbound-history').allowed)return res.status(429).json({error:'Too many requests.'});
 if(String(req.headers?.['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')return res.status(415).json({error:'Use JSON.'});
 try{
  if(Buffer.byteLength(JSON.stringify(req.body||{}))>4096)return res.status(413).json({error:'Request too large.'});
  const {command,signature}=req.body||{};if(!await verifyInboundHistoryCommand(command,signature))return res.status(401).json({error:'Invalid or expired wallet authorization.'});
  const result=await readInboundHistory(config,command);return res.status(result.status==='expired'?401:result.status==='history-changed'?409:200).json(result);
 }catch{return res.status(503).json({error:'Incoming forwarding history unavailable. A missing report does not prove that no message was published.'});}
}
