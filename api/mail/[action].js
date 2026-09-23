import {createConnectedMailHandler} from '../../server/connected-mail-http.js';
import inboundHistoryHandler from '../../server/inbound-history-http.js';
const connected=createConnectedMailHandler();
export default function handler(req,res){return req.query?.action==='inbound-history'?inboundHistoryHandler(req,res):connected(req,res);}
