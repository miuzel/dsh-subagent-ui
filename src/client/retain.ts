import type { RetainEntry, RetainWant, SessionBinding, SessionFace, SessionReference, SubagentAddress, Unsubscribe } from './types'
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
// The continue capability, resolved per row and re-evaluated on every render and
// every click — never cached at activation, because 0.1.7-rc.1 publishes its
// faces *after* a client plugin's apply runs and a one-shot probe once blanked a
// whole column silently. The capability is the Session's own `prompt`: no
// verified host exposes a service-level prompt on `ctx.sessions`, and a
// subagent-routing `ctx.subagents` service does not exist at all. The row's own
// face is read only when this plugin already holds one — 0.1.6+ borrows a
// binding solely for a generation somebody already retained, and on 0.1.5 a
// borrow materializes a scope, so borrowing an arbitrary row id at render would
// mint scopes this panel never releases, while the borrowed fallback ids are
// faces the client already holds (this conversation is the one the main view
// stages). Nothing here compares a version; an absent `prompt` on every
// reachable face is the absence of the capability, and no action is rendered.
export const continueFaceFor=(rowId:string,fallbackIds:string[])=>{
  const owned=retainOwned(rowId)?liveBindingFor(rowId)?.session:null
  if(owned&&typeof owned.prompt==='function')return owned
  for(const id of fallbackIds){
    if(!id||id===rowId)continue
    const face=liveBindingFor(id)?.session
    if(face&&typeof face.prompt==='function')return face
  }
  return null
}
// Mint one short-lived reference for a finished child and hand back the face
// that carries `prompt`, paired with the release that hands it back. `retain`
// mints the generation on 0.1.6+, while a host without it borrows the binding
// (the same fallback the live feed uses, and the path 0.1.5 needs because it has
// no `retain` at all). The reference is deliberately outside the surface budget
// in retainSync: it exists for one send, is released in the caller's `finally`,
// and must never evict a running row's live feed. A face without `prompt` means
// this host has no channel into the child, and the caller sends nothing.
export const acquirePromptFace=async(childId:string,address:SubagentAddress|null)=>{
  const runtime=sessionsRt
  let reference:SessionReference|null=null
  if(typeof runtime?.retain==='function'){
    try{reference=runtime.retain(address&&address.mode?address:childId,{source:RETAIN_SOURCE})}catch(error){console.warn('subagent-workspace-ui: unable to retain a session for the continue instruction',childId,error);return null}
    try{if(reference&&typeof reference.ready?.then==='function')await reference.ready}catch(error){console.warn('subagent-workspace-ui: the retained session never became ready',childId,error)}
    const face:SessionFace|null=retainBindingOf(reference)?.session||null
    if(!face||typeof face.prompt!=='function'){retainDispose(reference);return null}
    return {face,release:()=>retainDispose(reference)}
  }
  const face:SessionFace|null=liveBindingFor(childId)?.session||null
  if(!face||typeof face.prompt!=='function')return null
  return {face,release:()=>{}}
}
