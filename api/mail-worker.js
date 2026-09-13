import { timingSafeEqual } from 'node:crypto';
import { mailConfig, createMailService } from '../server/mail-service.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST') return res.status(405).json({error:'Use POST.'});
  const config=mailConfig();
  if(!config) return res.status(503).json({error:'Wallet email is not configured.'});
  const supplied=Buffer.from(String(req.headers?.authorization||'')); const expected=Buffer.from(`Bearer ${config.workerSecret}`);
  if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) return res.status(401).json({error:'Worker authorization required.'});
  try {return res.status(200).json(await createMailService(config).drain());}
  catch {return res.status(503).json({error:'Worker temporarily unavailable.'});}
}
