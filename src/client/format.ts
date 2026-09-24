import type { Tr, SessionSummary, SessionState, CatalogEntry, SubagentRow, CwdLike, TokenUsage } from './types'
export const age=(tr:Tr,stamp:number)=>{const seconds=Math.max(0,Math.floor((Date.now()-(stamp||Date.now()))/1000));if(seconds<60)return tr('age.sAgo',{s:seconds});const minutes=Math.floor(seconds/60);if(minutes<60)return tr('age.mAgo',{m:minutes});const hours=Math.floor(minutes/60);if(hours<24)return tr('age.hmAgo',{h:hours,m:minutes%60});return tr('age.dAgo',{d:Math.floor(hours/24)})}
// The official cache-hit share formatter, ported expression-for-expression from
// the host chat client (`@deepseek-ai/dsh-client-ui-chat/lib/client.js`:
// `roundedPercentUnits`, `displayPercentUnits` and `formatCacheHitPercent`; only
// the project's semicolon-free style and the type annotations are ours). It
// rounds in exact integer units with positive ties rounded up — never in
// floating point — and it never lets a partial hit read as a complete one: once
// the ordinary precision would reach 100 while prompt tokens were missed, the
// share gains exactly as many decimals as it takes to stay below it (99.6,
// 99.95, 99.9999 …) instead of claiming a full cache hit.
function roundedPercentUnits(cacheReadTokens:number,denominator:number,decimalPlaces:number){
  const scale=(decimalPlaces===0?1:10)*100
  const doubledScale=scale*2
  const denominatorQuotient=Math.floor(denominator/doubledScale)
  const denominatorRemainder=denominator%doubledScale
  let lower=0
  let upper=scale
  while(lower<upper){
    const candidate=Math.floor((lower+upper+1)/2)
    const factor=candidate*2-1
    if(cacheReadTokens>=factor*denominatorQuotient+Math.ceil(factor*denominatorRemainder/doubledScale))lower=candidate
    else upper=candidate-1
  }
  return lower
}
function displayPercentUnits(units:number,decimalPlaces:number){
  if(decimalPlaces===0)return String(units)
  const whole=Math.floor(units/10)
  const tenths=units%10
  return tenths===0?String(whole):`${whole}.${tenths}`
}
function formatCacheHitPercent(cacheReadTokens:number,promptTokens:number,decimalPlaces:number){
  if(promptTokens===0)return null
  const missedInputTokens=promptTokens-cacheReadTokens
  if(missedInputTokens===0)return '100'
  const roundedUnits=roundedPercentUnits(cacheReadTokens,promptTokens,decimalPlaces)
  if(roundedUnits<(decimalPlaces===0?100:1e3))return displayPercentUnits(roundedUnits,decimalPlaces)
  let distinguishingPlaces=1
  let scaledDoubleGap=missedInputTokens*200
  const denominatorTens=Math.floor(promptTokens/10)
  while(scaledDoubleGap<=denominatorTens){
    scaledDoubleGap*=10
    distinguishingPlaces+=1
  }
  const denominatorOnes=promptTokens%10
  let roundedLoss=5
  for(let loss=1;loss<5;loss+=1){
    const factor=loss*2+1
    const threshold=factor*denominatorTens+Math.floor(factor*denominatorOnes/10)
    if(scaledDoubleGap<=threshold){
      roundedLoss=loss
      break
    }
  }
  return `99.${'9'.repeat(distinguishingPlaces-1)}${10-roundedLoss}`
}
export const title:(s:SessionSummary)=>string=s=>s.title||s.displayTitle||s.id, short=(tr:Tr,v:string)=>v?v.replace(/^session-/,'').slice(0,8):tr('unknown'), workspace=(tr:Tr,s:CwdLike|undefined)=>s?.cwd?s.cwd.split(/[\\/]/).filter(Boolean).pop():tr('unknownWorkspace'), modeLabel=(tr:Tr,m:string|undefined)=>m==='one-shot'?tr('oneShot'):m==='continuable'?tr('continuable'):tr('typeLoading'), // Token arithmetic shared by every usage surface, mirroring the official chat
// client exactly: billed input = uncached + cache read + cache write (three
// disjoint prompt-side buckets), the usage total adds the output bucket, and the
// cache-hit share divides by billed input ALONE — never by the total, which
// would count the output tokens in a prompt-side ratio. Values are normalized
// once here (`num`) so a host that omits a bucket yields "unknown"/"omitted"
// instead of NaN leaking into the label.
num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:undefined,
billedTokens=(u:TokenUsage|undefined)=>{const uncached=num(u?.uncachedInputTokens),read=num(u?.cacheReadTokens),write=num(u?.cacheWriteTokens);return uncached==null||read==null||write==null?undefined:uncached+read+write},
// Official cache-hit semantics on top of the ported formatter above: a zero
// denominator has no share at all (the caller omits the segment), a fully cached
// prompt reads 100, a read that exceeds the billed input is meaningless and is
// normalized to "100" as before (the official routine assumes read <= billed),
// everything else is the official `formatCacheHitPercent` at integer precision,
// which escalates that precision when a partial hit would otherwise round to 100.
cacheHitText=(read:number|undefined,billed:number|undefined)=>billed==null||billed<=0||read==null?null:read>=billed?'100':formatCacheHitPercent(read,billed,0),
// Official tps: decode tokens over decode milliseconds, integer at >=10 and one
// decimal below; no text at all when the host reported no positive decoding
// window (a missing/zero window must never render as "0 tps").
tpsText=(tokens:number|undefined,ms:number|undefined)=>{const decodeTokens=num(tokens),decodeMs=num(ms);if(decodeTokens==null||decodeMs==null||decodeTokens<=0||decodeMs<=0)return null;const tps=decodeTokens/(decodeMs/1e3);return tps>=10?String(Math.round(tps)):String(Math.round(tps*10)/10)},
durationText=(ms:number)=>ms>=10000?`${Math.round(ms/1000)}s`:`${(ms/1000).toFixed(1)}s`,
fmt=(tr:Tr,n:number|null|undefined)=>n==null?tr('unknown'):n>=1e6?`${(n/1e6).toFixed(1)}m`:n>=1e3?`${(n/1e3).toFixed(1)}k`:String(n), promptPreview:(s:SessionSummary|undefined)=>string=s=>String(s?.prompt||s?.projectionValues?.prompt||'').slice(0,100),// The single usage reader: the host tokenUsage buckets plus the sessionStats
// decode window and turn/step counters, normalized once into one object. Both
// the inline line and the tooltip below are pure projections of THIS object, so
// the panel detail row and the active float can never disagree (and neither can
// the line and its own title). `turns`/`steps` keep the existing precedence
// (sessionStats first, then the flat projection, then the existing unknown text).
usageStats=(tr:Tr,row:SubagentRow|undefined)=>{const values=row?.projectionValues,u=values?.tokenUsage,s=values?.sessionStats,billed=billedTokens(u),cacheRead=num(u?.cacheReadTokens),output=num(u?.outputTokens);return{total:billed==null||output==null?undefined:billed+output,billed,uncached:num(u?.uncachedInputTokens),cacheRead,cacheWrite:num(u?.cacheWriteTokens),output,hit:cacheHitText(cacheRead,billed),tps:tpsText(num(s?.decodeTokens),num(s?.decodeMs)),turns:num(s?.turns)??num(values?.turns)??tr('unknown'),steps:num(s?.steps)??num(values?.steps)??tr('unknown'),llmMs:num(s?.llmMs),toolMs:num(s?.toolMs),ttftMs:num(s?.ttftMs)}},
// The inline line rendered by both surfaces (the manager's detail row and the
// active float). `↑` is billed input with its uncached part in parentheses, so
// the arrow matches the official footer total's input side instead of silently
// showing one bucket. The hit and tps segments are OMITTED when the host gave no
// denominator / no decoding window; joining here keeps an omitted segment from
// leaving a dangling separator.
statsLine=(tr:Tr,row:SubagentRow|undefined)=>{const u=usageStats(tr,row),parts=[tr('stats.usage',{input:fmt(tr,u.billed),uncached:fmt(tr,u.uncached),output:fmt(tr,u.output)})];if(u.hit!=null)parts.push(tr('stats.hit',{percent:u.hit}));if(u.tps!=null)parts.push(tr('stats.tps',{tps:u.tps}));parts.push(tr('stats.turns',{turns:u.turns}));parts.push(tr('stats.steps',{steps:u.steps}));return parts.join(' · ')},
// The complete picture behind the same reader, used as the native `title`
// tooltip on both surfaces: every bucket plus the derived share and speed.
// Bilingual per line, so one tooltip reads in either UI language, and the
// timing rows only appear when the host published them.
statsUsageTitle=(tr:Tr,row:SubagentRow|undefined)=>{const u=usageStats(tr,row),lines=[tr('stats.titleLine'),tr('stats.f.total',{value:fmt(tr,u.total)}),tr('stats.f.billed',{value:fmt(tr,u.billed)}),tr('stats.f.uncached',{value:fmt(tr,u.uncached)}),tr('stats.f.cacheRead',{value:fmt(tr,u.cacheRead)}),tr('stats.f.cacheWrite',{value:fmt(tr,u.cacheWrite)}),tr('stats.f.output',{value:fmt(tr,u.output)}),tr('stats.f.hit',{value:u.hit!=null?`${u.hit}%`:tr('unknown')}),tr('stats.f.tps',{value:u.tps!=null?tr('stats.tps',{tps:u.tps}):tr('unknown')}),tr('stats.f.turns',{value:u.turns}),tr('stats.f.steps',{value:u.steps})];if(u.llmMs!=null)lines.push(tr('stats.f.llm',{value:durationText(u.llmMs)}));if(u.toolMs!=null)lines.push(tr('stats.f.tool',{value:durationText(u.toolMs)}));if(u.ttftMs!=null)lines.push(tr('stats.f.ttft',{value:durationText(u.ttftMs)}));return lines.join('\n')}
export const category=(tr:Tr,name:string)=>{const clean=name.trim();const part=clean.split(/[:：|—–-]/)[0].trim();return part.length>1&&part.length<28?part:clean.split(/\\s+/).slice(0,2).join(' ')||tr('uncategorized')},rootSession=(byId:Record<string, SessionSummary>,id:string)=>{let current=id,seen=new Set();while(current&&byId[current]?.origin==='subagent'&&byId[current].parentId&&!seen.has(current)){seen.add(current);current=byId[current].parentId}return current}
// One reader, one fallback order, for the child's type — shared by the panel
// detail row, the row badge and the active float so the three surfaces cannot
// disagree. Rung 1 is the discovered parent-catalog entry, which the manager only
// holds once that parent's catalog has been pulled; that pull is why opening the
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
// One catalog reader for both host generations, so no caller learns which host it
// runs on. 0.1.6-alpha.2 publishes the discovered catalog as
// `subagentsByParent[parentId].entries` (kind-tagged `SubagentListEntry`), which
// 0.1.7-rc.1 dropped for the parent's own `subagentCatalog` projection
// (`{ id, createdAt, mode, label }[]` in catalog event order, no `kind`). Both are
// folded here in host order into the same `{ id, mode, label }` rows; a legacy
// catalog that exists is authoritative (old hosts keep their exact behavior), and
// an `'unknown'` mode keeps the label while leaving the mode to rung 2.
const knownMode=mode=>mode==='one-shot'||mode==='continuable'?mode:undefined
export const catalogEntriesOf=(state:SessionState|undefined,parentId:string)=>{const legacy=state?.subagentsByParent?.[parentId]?.entries;if(Array.isArray(legacy))return legacy.filter(e=>e.kind==='child').map(e=>({id:e.id,mode:knownMode(e.mode),label:e.label}));const projected=state?.byId?.[parentId]?.projectionValues?.subagentCatalog??state?.projectionsBySession?.[parentId]?.values?.subagentCatalog;return Array.isArray(projected)?projected.filter(e=>e&&e.id).map(e=>({id:e.id,mode:knownMode(e.mode),label:e.label})):[]}
export const catalogEntryOf=(state:SessionState|undefined,parentId:string,childId:string)=>catalogEntriesOf(state,parentId).find(e=>e.id===childId)
export const childModeOf=(s:SessionSummary|undefined,catalog:CatalogEntry|undefined)=>catalog?.mode??projectionMode(s)
export const modeMap:(state:SessionState|undefined)=>Record<string, CatalogEntry>=state=>{const parents=new Set<string>();Object.keys(state?.subagentsByParent||{}).forEach(id=>parents.add(id));Object.keys(state?.byId||{}).forEach(id=>{if(state?.byId?.[id]?.projectionValues?.subagentCatalog)parents.add(id)});Object.keys(state?.projectionsBySession||{}).forEach(id=>{if(state?.projectionsBySession?.[id]?.values?.subagentCatalog)parents.add(id)});const map:Record<string, CatalogEntry>={};parents.forEach(parentId=>{catalogEntriesOf(state,parentId).forEach(entry=>{if(map[entry.id]===undefined)map[entry.id]=entry})});return map}, highlight=(text:unknown,term:string)=>{if(!term)return text;const parts=String(text).split(new RegExp(`(${term.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')})`,'ig'));return parts.map((part,i)=>i%2?jsx('mark',{children:part},i):part)}
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
