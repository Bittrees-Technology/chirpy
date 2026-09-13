// Web-standard Request preserves the exact bytes required for webhook verification.
import { handleMailEvent } from '../server/mail-events.js';
export function POST(request) {return handleMailEvent(request);}
