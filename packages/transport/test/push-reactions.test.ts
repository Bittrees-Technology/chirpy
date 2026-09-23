import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateMessageObj } = require('@pushprotocol/restapi/src/lib/validations/messageObject.js');
const { CHAT } = require('@pushprotocol/restapi/src/lib/types/messageTypes.js');
import { PUSH_REACTIONS, withPushReactions } from '../src/pushReactions';
import { readPushHistory } from '../src/pushMessages';
import type { ChatMessage } from '../src/types';
const room = 'a'.repeat(64), conversationId = 'push:production:governance:'+room;
const sender = '0x'+'1'.repeat(40), other = '0x'+'2'.repeat(40), reference = 'QmOriginalMessage';
const row = (emoji:unknown = '👍', extra = {}) => ({cid:'QmReactionEvent',link:null,toDID:room,fromDID:sender,timestamp:1,messageType:'Reaction',messageObj:{content:emoji,reference},...extra});
const message = (id: string, extra:Partial<ChatMessage> = {}):ChatMessage => ({id,conversationId,sender,body:'Original',sentAt:1,...extra});
describe('native Push reactions',()=>{
 it('matches the installed SDK validator without inventing a removal operation',()=>{
  expect(new Set(PUSH_REACTIONS)).toEqual(new Set(Object.values(CHAT.REACTION)));
  for(const emoji of PUSH_REACTIONS) expect(()=>validateMessageObj({content:emoji,reference},'Reaction')).not.toThrow();
  expect(()=>validateMessageObj({content:'',reference},'Reaction')).toThrow();
 });
 it('reads the pinned SDK emoji set and preserves original event IDs and references',()=>{
  for(const emoji of PUSH_REACTIONS) expect(readPushHistory([row(emoji)],conversationId).messages[0]).toMatchObject({id:'QmReactionEvent',body:emoji,pushReaction:{emoji,reference}});
 });
 it('does not treat malformed, extra, active, removal or undecryptable content as a reaction',()=>{
  for(const item of [row(''),row('🎉'),row('<img onerror=x>'),row('👍',{messageObj:{content:'👍',reference:'../room'}}),row('👍',{messageObj:{content:'👍',reference:'QmReactionEvent'}}),row('👍',{messageObj:{content:'👍',reference,action:'remove'}}),row('👍',{messageObj:{reference}}),row('👍',{messageObj:'Unable to Decrypt Message'})]) {
   const result=readPushHistory([item],conversationId).messages[0];expect(result.pushReaction).toBeUndefined();expect(result.reactions).toBeUndefined();
  }
 });
 it('deduplicates each sender/emoji across the snapshot without conflating senders or emojis',()=>{
  const parent=message(reference),reaction=message('QmReactionEvent',{pushReaction:{reference,emoji:'👍'}});
  const result=withPushReactions([parent,reaction],[{reference,emoji:'👍',sender},{reference,emoji:'👍',sender:other},{reference,emoji:'❤️',sender}]);
  expect(result[0].reactions).toEqual({'👍':[sender,other],'❤️':[sender]});expect(result[1]).toBe(reaction);expect(parent.reactions).toBeUndefined();
 });
 it('uses linked ordering, never timestamps, and does not apply older or missing-target events',()=>{
  const early=message('QmEarlyReaction',{sentAt:9000,pushReaction:{reference,emoji:'👍'}}),parent=message(reference,{sentAt:0});
  const foreign=message('QmMissingReaction',{pushReaction:{reference:'QmNotInThisRoom',emoji:'❤️'}});
  expect(withPushReactions([early,parent,foreign],[])[1].reactions).toBeUndefined();
  expect(withPushReactions([parent,early],[])[0].reactions).toEqual({'👍':[sender]});
 });
 it('rejects foreign-room reaction envelopes and conflicting duplicate event contents',()=>{
  expect(()=>readPushHistory([row('👍',{toDID:'b'.repeat(64)})],conversationId)).toThrow();
  expect(()=>readPushHistory([row(),row('❤️')],conversationId)).toThrow();
  expect(()=>readPushHistory([row(),row('👍',{messageObj:{content:'👍',reference:'QmAnotherOriginal'}})],conversationId)).toThrow();
 });
});
