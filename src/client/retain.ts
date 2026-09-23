import type { RetainEntry, RetainWant, SessionBinding, SessionReference, Unsubscribe } from './types'
// The plugin is its own retainer. `sessions.binding(id)` only borrows a binding
// somebody else retained ("Borrow an already-retained binding without extending
// its lifetime ... or undefined without a retained generation"), and the only
// view-side retainer in the official client is the main conversation view, so
// before this module a child had a live feed only while it was the SELECTED
// session. `sessions.retain(target, {source})` creates the generation instead:
// `reference.binding` stays valid for the reference's lifetime and `release()`
// hands it back (the final reference starts scope + history teardown).
//
// Policy (owner-specified for g-011, deliberately bounded):
//   - the active float keeps every running child it displays while it is shown
//     (it is the resident multi-row surface, and this is the reported bug);
//   - the manager panel keeps the running rows it actually renders, so opening
//     the panel never touches the discovered-but-hidden history;
//   - both surfaces share RETAIN_LIMIT references; the float is served first
//     and, inside one surface, the most recently active child first. A child
//     past the cap keeps the durable snapshot path (no live region).
// Every reference is released when its row stops rendering, when the surface
// closes or unmounts, and when the plugin is disposed. A host without `retain`
// degrades to the borrowed `binding` of old, so nothing here can blank the UI.
export const RETAIN_SOURCE='subagentWorkspaceUi'
export const RETAIN_LIMIT=8
const retainOrder=['float','panel']
const retainWants=new Map<string, Map<string, RetainWant>>()
const retainEntries=new Map<string, RetainEntry>()
const retainListeners=new Set<Unsubscribe>()
const retainSignature=(want:RetainWant)=>`${want.parentId||''}|${want.mode||''}`
// The address is the same durable direct-parent form the host resolves for
// navigation and subagent configuration; a bare id is the fallback.
const retainTarget=(want:RetainWant)=>want.parentId&&want.mode?{parentSessionId:want.parentId,childSessionId:want.childId,mode:want.mode}:want.childId
const retainNotify=()=>{retainListeners.forEach(listener=>{try{listener()}catch(error){console.warn('subagent-workspace-ui: retain listener failed',error)}})}
const retainDispose=(reference:SessionReference|null)=>{if(!reference)return;try{if(typeof reference.release==='function')reference.release();else if(typeof reference.dispose==='function')reference.dispose()}catch(error){console.warn('subagent-workspace-ui: unable to release a retained session',error)}}
// Reading `binding` on a released or disposed generation throws by contract, so
// every read is guarded and a throwing read simply loses this row's live feed.
const retainBindingOf=(reference:SessionReference|null)=>{if(!reference)return null;try{const binding=reference.binding;return binding&&(binding.session||binding.eventSource)?binding:null}catch{return null}}
const retainDrop=(childId:string)=>{const entry=retainEntries.get(childId);if(!entry)return false;retainEntries.delete(childId);retainDispose(entry.reference);return true}
const retainAcquire=(want:RetainWant)=>{const runtime=sessionsRt;if(!runtime||typeof runtime.retain!=='function')return null;let reference=null;try{reference=runtime.retain(retainTarget(want),{source:RETAIN_SOURCE})}catch(error){console.warn('subagent-workspace-ui: unable to retain a live session',want.childId,error);return null}const binding=retainBindingOf(reference);if(!binding){retainDispose(reference);return null}return {reference,binding,signature:retainSignature(want)}}
// Reconcile the held references with what the surfaces currently want: release
// what fell out (or whose address changed), acquire what came in, in cap order.
const retainSync=()=>{const ranked:RetainWant[]=[];for(const owner of retainOrder){const group=retainWants.get(owner);if(!group)continue;const list=[...group.values()].filter(want=>want&&want.childId);list.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));for(const want of list)ranked.push(want)}const kept:RetainWant[]=[],seen=new Set<string>();for(const want of ranked){if(kept.length>=RETAIN_LIMIT)break;if(seen.has(want.childId))continue;seen.add(want.childId);kept.push(want)}let changed=false;for(const childId of [...retainEntries.keys()]){const want=kept.find(item=>item.childId===childId);if(!want||retainSignature(want)!==retainEntries.get(childId)?.signature){if(retainDrop(childId))changed=true}}for(const want of kept){if(retainEntries.has(want.childId))continue;const entry=retainAcquire(want);if(entry){retainEntries.set(want.childId,entry);changed=true}}if(changed)retainNotify()}
// A surface declares the complete set it wants; the effect that owns the
// surface re-declares whenever its rendered rows change and calls
// retainClear on unmount (never between two declarations, so a store push
// cannot churn retain/release pairs).
export const retainDeclare=(owner:string,wants:RetainWant[])=>{const group=new Map<string, RetainWant>();for(const want of wants)if(want&&want.childId)group.set(want.childId,want);retainWants.set(owner,group);retainSync()}
export const retainClear=(owner:string)=>{if(retainWants.delete(owner))retainSync()}
export const retainReleaseAll=()=>{retainWants.clear();let changed=false;for(const childId of [...retainEntries.keys()])if(retainDrop(childId))changed=true;if(changed)retainNotify()}
// The single live-output entry: this plugin's own reference first, the borrowed
// binding of old second (capability fallback, never a version check).
export const liveBindingFor=(childId:string)=>{const entry=retainEntries.get(childId);if(entry){const own=retainBindingOf(entry.reference);if(own)return own}try{return sessionsRt?.binding?.(childId)||null}catch{return null}}
export const retainOwned=(childId:string)=>retainEntries.has(childId)
export const retainSettled=async(childId:string)=>{const entry=retainEntries.get(childId);if(!entry)return;try{await entry.reference.ready}catch{}}
export const retainSubscribe=(listener:Unsubscribe)=>{retainListeners.add(listener);return()=>{retainListeners.delete(listener)}}
