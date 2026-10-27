import {describe,it,expect} from 'vitest';
import {parseSectionPreferences,sectionPreferencesKey} from '../src/featurePreferences';
describe('optional section preferences',()=>{
 it('defaults every section off and accepts partial explicit choices',()=>{
  expect(parseSectionPreferences(null)).toEqual({rooms:false,mail:false,routes:false,forum:false});
  expect(parseSectionPreferences('{"mail":true}')).toEqual({rooms:false,mail:true,routes:false,forum:false});
 });
 it('rejects malformed choices without coercing permission-like strings',()=>{
  for(const raw of ['null','[]','{"mail":"true"}','{"unknown":true}','{"rooms":null}','x',' '.repeat(1025)]) expect(()=>parseSectionPreferences(raw)).toThrow();
 });
 it('isolates wallet and local profiles, normalizing wallet case',()=>{
  expect(sectionPreferencesKey('0xABC','wallet')).toBe(sectionPreferencesKey('0xabc','wallet'));
  expect(sectionPreferencesKey('0xabc','wallet')).not.toBe(sectionPreferencesKey('0xabc','stub'));
  expect(sectionPreferencesKey('0xabc','wallet')).not.toBe(sectionPreferencesKey('0xdef','wallet'));
 });
});

import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {useSectionPreferences} from '../src/featurePreferences';
import {vi} from 'vitest';
it('keeps choices off and preserves stored data when a save fails',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const records=new Map<string,string>();
 vi.stubGlobal('localStorage',{getItem:(key:string)=>records.get(key)??null,setItem:()=>{throw new DOMException('full','QuotaExceededError');}});
 let settings!:ReturnType<typeof useSectionPreferences>;
 function Probe(){settings=useSectionPreferences('0xabc','wallet');return null;}
 const root=createRoot(document.createElement('div'));
 try{
  await act(async()=>root.render(React.createElement(Probe)));
  await act(async()=>settings.setSection('mail',true));
  expect(settings.error).toBe(true);expect(settings.sections.mail).toBe(false);expect(records.size).toBe(0);
 }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();}
});
