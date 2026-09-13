import { timingSafeEqual } from 'node:crypto';
import { mailConfig, createMailService } from '../server/mail-service.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST') return res.status(405).json({error:'Use POST.'});
  const config=mailConfig();
  if(!config) return res.status(503).json({error:'Wallet email is not configured.'});
  const supplied=Buffer.from(String(req.headers?.authorization||'')); const expected=Buffer.from(`Bearer ${config.workerSecret}`);
  if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return res.status(401).json({error:'Worker authorization required.'});
  const body=req.body;
  const action=body===undefined || body==='' ? 'tick' : body?.action;
  if ((body && (typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>k!=='action'))) || !['tick','status'].includes(action)) return res.status(400).json({error:'Use action tick or status.'});
  try {
    const service=createMailService(config);
    return res.status(200).json(await (action==='status'?service.workerStatus():service.drain()));
  }
  catch {return res.status(503).json({error:'Worker temporarily unavailable.'});}
}
