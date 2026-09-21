import { NS, zh, en } from './i18n'
import { Manager } from './manager'
import type { LineageShadowProps, PluginCtx, UiWorkspaceRuntime } from './types'
// Navigation capability probe. Order matters: sessions.openSubagent(address) is
// object-capable and present through 0.1.6-alpha.1, while uiWorkspace.openSession
// only accepts a SessionTarget from 0.1.6-alpha.2 on (before that it is
// openSession(sessionId) -> sessions.open(id) and throws on an address), so
// uiWorkspace is the fallback for the hosts where the sessions methods are gone.
const uiWorkspaceOf=ctx=>{try{const ws=ctx.get?.('uiWorkspace');return typeof ws?.openSession==='function'?ws:null}catch{return null}}
// Optional-service probe. Every right-sidebar face is optional here: an absent
// service must degrade to "no sidebar button", never to a plugin that fails to
// activate (the manager itself has to keep working on hosts without a sidebar).
const serviceOf=(ctx,name)=>{try{const value=ctx.get?.(name);return value??null}catch(error){console.warn('subagent-workspace-ui: service probe failed for',name,error);return null}}
// Lineage shadow. The manager reuses the stock ui-subagent plugin (its
// right-sidebar chat tab is what the new button opens), so that plugin stays
// enabled and this registration is what keeps its lineage dropdown invisible: a
// `single` slot renders its lowest-priority winner, and -1 outranks the stock
// registration's default 0 without colliding with it.
//
// The shadow renders no dropdown. It DOES re-render the breadcrumb title for a
// crumb that is itself a subagent session, because `renderSlot` REPLACES the
// caller's fallback once an entry exists (the conversation draws the title
// itself for every other crumb, so those must render nothing here): a literally
// empty shadow would delete the current subagent session's title from the
// header. The title is drawn with the conversation's own crumb metrics (see the
// dsh-sam-lineage-* rules in styles.ts) and keeps the ancestor-crumb click that
// the fallback button had.
const LineageShadow=({displayTitle,lineageSessionId,useSessions,openTitle}:LineageShadowProps)=>{
  const isSubagent=typeof useSessions==='function'?useSessions(s=>s?.byId?.[lineageSessionId]?.origin==='subagent'):false
  if(!isSubagent||!displayTitle)return null
  const open=typeof openTitle==='function'?openTitle:null
  return jsx('button',{type:'button',className:open?'dsh-sam-lineage-title':'dsh-sam-lineage-title dsh-sam-lineage-current',disabled:!open,title:displayTitle,onClick:open||undefined,children:displayTitle})
}
// Canonical `subagentchat` resource address. The stock ui-subagent bundle keeps
// both the prefix and its builder inside its own module closure (it exports only
// `inject` and `apply`, so `require()` cannot hand the builder over), which
// leaves rebuilding the address in the canonical form its tab type parses. The
// rebuild is never trusted on its own: `sidebarRightTabs.candidates(address)`
// runs that type's own `canOpen` — which re-parses the parent and the routing
// mode — before a row offers the button at all, so a drifted format degrades to
// an unavailable button instead of throwing when the user clicks.
const SUBAGENT_CHAT_PREFIX='dsh-resource://subagentchat/session/'
const subagentChatAddressOf=address=>`${SUBAGENT_CHAT_PREFIX}${encodeURIComponent(address.childSessionId)}?${new URLSearchParams({parent:address.parentSessionId,mode:address.mode})}`
export function apply(ctx:PluginCtx){
  sessionsRt=ctx.sessions
  ctx.effect(()=>ctx.locale.register(NS,{zh,en}),'subagent-workspace-ui: dictionaries')
  const actions={openChild:a=>{if(typeof ctx.sessions?.openSubagent==='function'){ctx.sessions.openSubagent(a);return true}const ws=uiWorkspaceOf(ctx);if(ws){ws.openSession(a);return true}if(a?.childSessionId)return actions.openSession(a.childSessionId);return false},openSession:id=>{if(typeof ctx.sessions?.open==='function'){ctx.sessions.open(id);return true}const ws=uiWorkspaceOf(ctx);if(ws){ws.openSession(id);return true}return false},refresh:p=>ctx.sessions.refreshSubagents(p),setCatalogOpen:(p,o)=>ctx.sessions.setSubagentCatalogOpen(p,o)}
  const sidebarRight=serviceOf(ctx,'sidebarRight'),tabs=serviceOf(ctx,'sidebarRightTabs'),
    asideAddressOf=(sidebarRight&&typeof sidebarRight.openResource==='function'&&tabs&&typeof tabs.candidates==='function'&&typeof ctx.sessions?.subagentAddress==='function')?row=>{
      try{
        const address=ctx.sessions.subagentAddress(row.id)
        if(!address||!address.parentSessionId||!address.childSessionId||!address.mode)return null
        const value=subagentChatAddressOf(address)
        if(tabs.candidates(value).length===0)return null
        return value
      }catch(error){console.warn('subagent-workspace-ui: unable to resolve a sidebar address',error);return null}
    }:null,
    openAside=asideAddressOf?address=>{
      // `preferNewPane` is the placement the stock "open aside" action uses, so a
      // split-capable column keeps the main conversation visible. openResource
      // expands the column itself; toggling it here would fight that.
      try{sidebarRight.openResource(address,{preferNewPane:true});return true}catch(error){console.warn('subagent-workspace-ui: unable to open the sidebar resource',address,error);return false}
    }:null,
    face=()=>({...actions,asideAddressOf,openAside})
  ctx.slots.inject('conversation.session.header.actions',()=>ctx.slots.register({name:'conversation.session.header.actions',id:'subagent-workspace-manager',order:100,locale:NS,inject:face},Manager))
  ctx.slots.inject('conversation.session.header.lineage',()=>ctx.slots.register({name:'conversation.session.header.lineage',priority:-1},LineageShadow))
}
