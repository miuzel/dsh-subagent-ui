import type { Tr, SessionSummary, ParentSubagents, ModeInfo, SubagentRow, CwdLike } from './types'
export const age=(tr:Tr,stamp:number)=>{const seconds=Math.max(0,Math.floor((Date.now()-(stamp||Date.now()))/1000));if(seconds<60)return tr('age.sAgo',{s:seconds});const minutes=Math.floor(seconds/60);if(minutes<60)return tr('age.mAgo',{m:minutes});const hours=Math.floor(minutes/60);if(hours<24)return tr('age.hmAgo',{h:hours,m:minutes%60});return tr('age.dAgo',{d:Math.floor(hours/24)})}
export const title:(s:SessionSummary)=>string=s=>s.title||s.displayTitle||s.id, short=(tr:Tr,v:string)=>v?v.replace(/^session-/,'').slice(0,8):tr('unknown'), workspace=(tr:Tr,s:CwdLike|undefined)=>s?.cwd?s.cwd.split(/[\\/]/).filter(Boolean).pop():tr('unknownWorkspace'), modeLabel=(tr:Tr,m:string|undefined)=>m==='one-shot'?tr('oneShot'):m==='continuable'?tr('continuable'):tr('typeLoading'), tokenTotal:(s:SessionSummary|undefined)=>number|undefined=s=>{const u=s?.projectionValues?.tokenUsage;return u?u.uncachedInputTokens+u.outputTokens+u.cacheReadTokens+u.cacheWriteTokens:undefined},fmt=(tr:Tr,n:number|null|undefined)=>n==null?tr('unknown'):n>=1e6?`${(n/1e6).toFixed(1)}m`:n>=1e3?`${(n/1e3).toFixed(1)}k`:String(n), promptPreview:(s:SessionSummary|undefined)=>string=s=>String(s?.prompt||s?.projectionValues?.prompt||'').slice(0,100),statsLine=(tr:Tr,row:SubagentRow|undefined)=>{const u=row?.projectionValues?.tokenUsage,t=tokenTotal(row);return tr('statsLine',{input:fmt(tr,u?.uncachedInputTokens),output:fmt(tr,u?.outputTokens),cacheHit:u?.cacheReadTokens!=null&&t?Math.round(u.cacheReadTokens/t*100):tr('unknown'),turns:row?.projectionValues?.sessionStats?.turns??row?.projectionValues?.turns??tr('unknown'),steps:row?.projectionValues?.sessionStats?.steps??row?.projectionValues?.steps??tr('unknown')})}
export const category=(tr:Tr,name:string)=>{const clean=name.trim();const part=clean.split(/[:：|—–-]/)[0].trim();return part.length>1&&part.length<28?part:clean.split(/\\s+/).slice(0,2).join(' ')||tr('uncategorized')},rootSession=(byId:Record<string, SessionSummary>,id:string)=>{let current=id,seen=new Set();while(current&&byId[current]?.origin==='subagent'&&byId[current].parentId&&!seen.has(current)){seen.add(current);current=byId[current].parentId}return current}
// One reader, one fallback order, for the child's type — shared by the panel
// detail row, the row badge and the active float so the three surfaces cannot
// disagree. Rung 1 is the discovered parent-catalog entry
// (`subagentsByParent[parentId].entries[].mode`), which the manager only holds
// once that parent's catalog has been pulled; that pull is why opening the
// panel used to "fix" the type. Rung 2 is the child's own `subagent` identity
// projection: the host pushes it on the live-control stream and on every
// session-added summary, so a fresh child carries it before any catalog pull.
// The projection is read by shape, never by version: the client view is the flat
// identity (`{ mode, label, seq }`, or the `null` sentinel when no valid
// descriptor exists), while a host fold state nests the same identity under
// `identity`. Both rungs silent resolves to nothing at all, so the shared
// `modeLabel` keeps rendering the existing `typeLoading` text; the reader never
// fabricates a mode, and a missing projection stays capability absence.
export const projectionMode=(s:SessionSummary|undefined)=>{const raw=s?.projectionValues?.subagent,identity=raw?.identity,mode=identity?identity.mode:raw?.mode;return mode==='one-shot'||mode==='continuable'?mode:undefined}
export const childModeOf=(s:SessionSummary|undefined,catalog:ModeInfo|undefined)=>catalog?.mode??projectionMode(s)
export const modeMap:(c:Record<string, ParentSubagents>|undefined)=>Record<string, ModeInfo>=c=>Object.values(c||{}).flatMap(x=>x.entries||[]).reduce((o,e)=>{if(e.kind==='child')o[e.id]={mode:e.mode,label:e.label};return o},{}), highlight=(text:unknown,term:string)=>{if(!term)return text;const parts=String(text).split(new RegExp(`(${term.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')})`,'ig'));return parts.map((part,i)=>i%2?jsx('mark',{children:part},i):part)}
// Model selection is a read-only capability probe: the host projection key is
// absent on older hosts, and both of its fields are null until the session
// records a request, so a missing value renders as the i18n fallback instead of
// a dirty null/null. `next` is what the next request would use and `lastUsed`
// what a request actually used, so prefer `next` and fall back to `lastUsed`.
export const modelText=(row:SubagentRow|undefined)=>{const sel=row?.projectionValues?.modelSelection,shown=sel?.next??sel?.lastUsed;if(!shown||!shown.provider||!shown.model)return '';return shown.reasoningEffort?`${shown.provider}/${shown.model} · ${shown.reasoningEffort}`:`${shown.provider}/${shown.model}`}
export const modelLabel=(tr:Tr,row:SubagentRow|undefined)=>{const text=modelText(row);return text?tr('model.label',{model:text}):tr('modelUnknown')}
export const modelCompact=(tr:Tr,row:SubagentRow|undefined)=>modelText(row)||tr('modelUnknown')
// Both densities share one source, one precedence and one fallback; only the
// surrounding labels differ (full in the panel details, bare in the float).
export const modeModelLine=(tr:Tr,row:SubagentRow|undefined)=>`${tr('mode.label',{mode:modeLabel(tr,row?.mode)})} · ${modelLabel(tr,row)}`
export const modeModelCompact=(tr:Tr,row:SubagentRow|undefined)=>`${modeLabel(tr,row?.mode)} · ${modelCompact(tr,row)}`
// The right-sidebar action shared by both presentation surfaces (the manager
// panel row and the active float). `addressOf` is the capability probe: when the
// host exposes no right-sidebar face it is null and no button is rendered at
// all; when it exists but this row has no usable address, the button renders
// disabled with a readable reason instead of disappearing. The click always
// stops propagation so the row's own "open in the main conversation" default
// never runs, and a wiring failure never surfaces as an exception.
export const asideButton=(options:{tr:Tr,row:SubagentRow,addressOf?:((row:SubagentRow)=>string|null)|null,open?:((address:string)=>boolean)|null,compact?:boolean,onOpened?:()=>void})=>{
  const addressOf=options.addressOf
  if(typeof addressOf!=='function')return null
  const tr=options.tr
  let address=null
  try{address=addressOf(options.row)}catch(error){console.warn('subagent-workspace-ui: sidebar address lookup failed',error);address=null}
  return jsx('button',{type:'button',className:options.compact?'dsh-sam-side-btn dsh-sam-side-btn-compact':'dsh-sam-side-btn',disabled:!address,title:address?tr('openInSidebar'):tr('openInSidebarUnavailable'),'aria-label':address?tr('openInSidebar.named',{name:options.row.name}):tr('openInSidebarUnavailable'),onClick:event=>{event.stopPropagation();if(!address)return;if(typeof options.open==='function'&&options.open(address)===true){if(typeof options.onOpened==='function')options.onOpened();return}window.alert(tr('openInSidebarFailed'))},children:'◫'})
}
