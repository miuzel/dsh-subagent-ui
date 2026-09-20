import { NS, zh, en } from './i18n'
import { Manager } from './manager'
import type { PluginCtx, UiWorkspaceRuntime } from './types'
// Navigation capability probe. Order matters: sessions.openSubagent(address) is
// object-capable and present through 0.1.6-alpha.1, while uiWorkspace.openSession
// only accepts a SessionTarget from 0.1.6-alpha.2 on (before that it is
// openSession(sessionId) -> sessions.open(id) and throws on an address), so
// uiWorkspace is the fallback for the hosts where the sessions methods are gone.
const uiWorkspaceOf=ctx=>{try{const ws=ctx.get?.('uiWorkspace');return typeof ws?.openSession==='function'?ws:null}catch{return null}}
export function apply(ctx:PluginCtx){sessionsRt=ctx.sessions;ctx.effect(()=>ctx.locale.register(NS,{zh,en}),'subagent-workspace-ui: dictionaries');const actions={openChild:a=>{if(typeof ctx.sessions?.openSubagent==='function'){ctx.sessions.openSubagent(a);return true}const ws=uiWorkspaceOf(ctx);if(ws){ws.openSession(a);return true}if(a?.childSessionId)return actions.openSession(a.childSessionId);return false},openSession:id=>{if(typeof ctx.sessions?.open==='function'){ctx.sessions.open(id);return true}const ws=uiWorkspaceOf(ctx);if(ws){ws.openSession(id);return true}return false},refresh:p=>ctx.sessions.refreshSubagents(p),setCatalogOpen:(p,o)=>ctx.sessions.setSubagentCatalogOpen(p,o)},face=()=>actions;ctx.slots.inject('conversation.session.header.actions',()=>ctx.slots.register({name:'conversation.session.header.actions',id:'subagent-workspace-manager',order:100,locale:NS,inject:face},Manager))}
