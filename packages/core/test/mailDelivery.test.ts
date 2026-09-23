import {it,expect} from 'vitest';
import {parseMailDeliveryDetails} from '../src/mailAuth.js';
const delivered={type:'delivered',occurredAt:1700000000000};
it('sorts independent facts, preserves conflicting outcomes and returns a bounded copy',()=>{
 const data={version:1,events:[{type:'bounced',occurredAt:1700000001000},delivered]};const parsed=parseMailDeliveryDetails(data);expect(parsed.events.map(e=>e.type)).toEqual(['delivered','bounced']);expect(parsed.events[0]).not.toBe(delivered);expect(parseMailDeliveryDetails({version:1,events:[]})).toEqual({version:1,events:[]});
});
it.each([null,{version:2,events:[]},{version:1,events:[delivered,delivered]},{version:1,events:[{...delivered,type:'opened'}]},{version:1,events:[{...delivered,occurredAt:0}]},{version:1,events:[{...delivered,providerId:'private'}]},{version:1,events:Array(8).fill(delivered)},{version:1,events:[],private:'private'}])('rejects malformed or private provider evidence',value=>{expect(()=>parseMailDeliveryDetails(value)).toThrow('Invalid provider delivery evidence.');});
