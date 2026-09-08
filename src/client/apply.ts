import { NS, zh, en } from './i18n'
import { Manager } from './manager'
import type { PluginCtx } from './types'
export function apply(ctx:PluginCtx){sessionsRt=ctx.sessions;ctx.effect(()=>ctx.locale.register(NS,{zh,en}),'subagent-workspace-ui: dictionaries');const actions={openChild:a=>ctx.sessions.openSubagent(a),openSession:id=>ctx.sessions.open(id),refresh:p=>ctx.sessions.refreshSubagents(p),setCatalogOpen:(p,o)=>ctx.sessions.setSubagentCatalogOpen(p,o)},face=()=>actions;ctx.slots.inject('conversation.session.header.actions',()=>ctx.slots.register({name:'conversation.session.header.actions',id:'subagent-workspace-manager',order:100,locale:NS,inject:face},Manager))}
