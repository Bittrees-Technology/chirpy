// Web-standard Request preserves the signed raw bytes; no browser/body-parser path.
import { handleInboundMail } from '../server/inbound-mail.js';
export function POST(request) {return handleInboundMail(request);}
