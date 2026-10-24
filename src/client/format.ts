import type { Tr, SessionSummary, SessionState, CatalogEntry, SubagentRow, CwdLike, TokenUsage, SubagentMode, ExternalState, ExternalStates, ExternalLedger, SessionEntities } from './types'
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
export const title:(s:SessionSummary)=>string=s=>s.title||s.displayTitle||s.id, short=(tr:Tr,v:string)=>v?v.replace(/^session-/,'').slice(0,8):tr('unknown'), workspace=(tr:Tr,s:CwdLike|undefined)=>s?.cwd?s.cwd.split(/[\\/]/).filter(Boolean).pop():tr('unknownWorkspace'), modeLabel=(tr:Tr,m:string|undefined)=>m==='one-shot'?tr('oneShot'):m==='continuable'?tr('continuable'):m==='external'?tr('external'):tr('typeLoading'), // Token arithmetic shared by every usage surface, mirroring the official chat
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
//
// `'external'` is the third arm: dsh 0.2.1 records an execution from a provider
// without `prepareContinuable` with catalog `version: 2, mode: 'external'`. It used
// to be dropped here, which demoted those children to mode-less rows the manager
// could not label — the whole reason external agents were invisible.
const knownMode:(mode:unknown)=>SubagentMode|undefined=mode=>mode==='one-shot'||mode==='continuable'||mode==='external'?mode:undefined
export const catalogEntriesOf=(state:SessionState|undefined,parentId:string)=>{const legacy=state?.subagentsByParent?.[parentId]?.entries;if(Array.isArray(legacy))return legacy.filter(e=>e.kind==='child').map(e=>({id:e.id,mode:knownMode(e.mode),label:e.label}));const projected=state?.byId?.[parentId]?.projectionValues?.subagentCatalog??state?.projectionsBySession?.[parentId]?.values?.subagentCatalog;return Array.isArray(projected)?projected.filter(e=>e&&e.id).map(e=>({id:e.id,mode:knownMode(e.mode),label:e.label})):[]}
export const catalogEntryOf=(state:SessionState|undefined,parentId:string,childId:string)=>catalogEntriesOf(state,parentId).find(e=>e.id===childId)
// Every parent Session that publishes a direct-child catalog, paired with that
// parent's own entries. `modeMap` folds the entries by child id and DROPS the
// parent; an external execution has no Session of its own, so its parent can
// only be recovered from here — this is the index the synthesized external rows
// are built from.
export const catalogParents=(state:SessionState|undefined):{parentId:string;entries:CatalogEntry[]}[]=>{
  const parents=new Set<string>()
  Object.keys(state?.subagentsByParent||{}).forEach(id=>parents.add(id))
  Object.keys(state?.byId||{}).forEach(id=>{if(state?.byId?.[id]?.projectionValues?.subagentCatalog)parents.add(id)})
  Object.keys(state?.projectionsBySession||{}).forEach(id=>{if(state?.projectionsBySession?.[id]?.values?.subagentCatalog)parents.add(id)})
  return [...parents].map(parentId=>({parentId,entries:catalogEntriesOf(state,parentId)}))
}
export const childModeOf=(s:SessionSummary|undefined,catalog:CatalogEntry|undefined)=>catalog?.mode??projectionMode(s)
export const modeMap:(state:SessionState|undefined)=>Record<string, CatalogEntry>=state=>{const map:Record<string, CatalogEntry>={};catalogParents(state).forEach(({entries})=>{entries.forEach(entry=>{if(map[entry.id]===undefined)map[entry.id]=entry})});return map}
// Rows for external executions that have NO Session in `byId`.
//
// This is the piece the external feature was missing: `byId` is the host's
// SESSION store, and an external execution (claude-code / codex) never creates a
// child Session — its catalog id is a bare `randomUUID()`. A row built only from
// `byId` therefore can never show one, which is why the manager said "no
// subagents match" while the host was running a codex agent.
//
// The row is synthesized from the facts that DO exist:
// - `parentId`: the parent Session whose catalog lists this id (the only source
//   that binds an external child to a parent);
// - `mode`: `'external'` from that catalog entry;
// - `name`: the catalog `label`, else the short id (never the provider, which is
//   the family's engine, not the agent's name);
// - `startedAt`/`updatedAt`: the measured `startedAt` of a lifecycle edge, else
//   `0` for a row whose run this page cannot see. `0` is deliberate: an unknown
//   time must not outrank a real one in a recency sort, and `updatedAt >= 0`
//   still passes every "is it old" filter.
// `running` stays false here; it is set by the caller from the lifecycle state,
// because the host's own `activity` is a constant for these ids.
//
// Deletion is the one fact the catalog cannot express: its projection is
// append-only, so a deleted child keeps its entry forever. `removedExternal` is
// the browser's own record of a completed deletion (see Prefs.removedExternal)
// and is the ONE signal consulted here — never `activity` (a constant for these
// ids), never a time threshold. A child the ledger reports RUNNING right now is
// still shown, because a live run outranks a past deletion of the same id.
export const deletedExternalOf=(removedExternal:string[]|undefined,externalStates:ExternalStates|undefined)=>{const removed=new Set<string>(Array.isArray(removedExternal)?removedExternal:[]);return (id:string)=>removed.has(id)&&externalStates?.[id]?.status!=='running'}
// ------------------------------------------------------------------ existence
// THE FACT the two readers below are built on, folded once from the host's
// answers (`session-entity`, one batch per candidate set; also folded into the
// ledger poll as `entity`). A child id lands in this set ONLY when the host said,
// for a root it could actually READ, that no project directory holds it — i.e.
// the child's session directory is gone because this plugin deleted it. Every
// other arm (root unreadable, one slug unlistable, an id the host could not
// encode, an id nobody asked about, an answer with no lists at all, a malformed
// payload) keeps the id OUT of the set, and an id outside the set is always
// shown. "Probe failed => show the row" is therefore a property of the data
// structure, not a branch somebody has to remember to write.
export const sessionEntitiesOf=(answers:unknown)=>{
  const absent=new Set<string>()
  const present=new Set<string>()
  const list=Array.isArray(answers)?answers:[answers]
  for(const answer of list){
    if(!answer||typeof answer!=='object')continue
    // An `ok:false` answer is a refusal, never evidence of deletion.
    if(answer.ok===false)continue
    // Only a root the host could read supports an "absent" verdict; `partial`
    // is downgraded by the host already, and `unavailable`/missing root is
    // treated as "nothing was read".
    if(answer.root!=='read')continue
    const gone=Array.isArray(answer.absent)?answer.absent:[]
    const there=Array.isArray(answer.present)?answer.present:[]
    for(const id of there){if(typeof id==='string'&&id)present.add(id)}
    for(const id of gone){if(typeof id==='string'&&id)absent.add(id)}
  }
  // A contradictory answer (the same id in both lists) is not evidence: show it.
  for(const id of present)absent.delete(id)
  return absent
}
// The ONE rule for synthesizing an "existence-filtered" row:
// - `absent` (host read the root, no directory) AND not running right now =>
//   hide. A live lifecycle edge outranks that memory, so a re-delegated id is
//   never masked;
// - anything else => show. This is the default for every row the host did not
//   or could not answer about.
export const absentRowOf=(absent:SessionEntities|undefined,externalStates:ExternalStates|undefined)=>{const gone=absent instanceof Set?absent:new Set<string>();return (id:string)=>gone.has(id)&&externalStates?.[id]?.status!=='running'}
// The rows that `byId` can never produce, synthesized from the catalog. Two
// independent reasons may hide one, and either is enough:
// 1. this browser's own deletion record (`removedExternal`, a list in prefs) —
//    the pre-existing signal, kept so behavior is additive;
// 2. the HOST's existence answer (`absent`, a set of ids the host positively
//    found with no session directory left). This is the rung that repairs the
//    reported bug: after the operator reinstalls/restarts/refreshes, the
//    browser-local record of an old deletion is not what has to be trusted —
//    the host says, for a root it read, that the child's directory is gone.
// Both are overridden by a live lifecycle edge: a child the ledger reports
// RUNNING is shown no matter what either memory says.
export const externalRowsOf=(tr:Tr,state:SessionState|undefined,externalStates:ExternalStates,removedExternal?:string[],absent?:SessionEntities)=>{
  const byId=state?.byId||{}
  const rows:SubagentRow[]=[]
  const seen=new Set<string>()
  const deleted=deletedExternalOf(removedExternal,externalStates)
  const gone=absentRowOf(absent,externalStates)
  catalogParents(state).forEach(({parentId,entries})=>{
    const parent=byId[parentId]
    if(!parent)return
    entries.forEach(entry=>{
      if(entry.mode!=='external'||byId[entry.id]||seen.has(entry.id))return
      // A child this browser deleted keeps its catalog record forever (the host
      // projection is append-only) but must not come back as a stub row — unless
      // the host is running it right now (rung 1).
      if(deleted(entry.id))return
      // A child the host reports as having no session directory at all is gone
      // for real (rung 2) — again unless it is running right now.
      if(gone(entry.id))return
      // A parent whose `origin` says subagent is itself a child; take the root so
      // the row groups with the workspace the operator sees.
      const root=rootSession(byId,parentId)
      const owner=byId[root]||parent
      const external=externalStates[entry.id]
      const startedAt=typeof external?.startedAt==='number'?external.startedAt:0
      // The workspace comes from the ROOT's `cwd`; when the root publishes none,
      // fall back to the catalog parent's so the row is never orphaned into
      // "unknown workspace" while its parent lives in a real one.
      const cwd=owner.cwd||parent.cwd
      seen.add(entry.id)
      rows.push({id:entry.id,parentId,origin:'external',name:entry.label||short(tr,entry.id),mode:'external',label:entry.label,createdAt:startedAt||undefined,updatedAt:startedAt,cwd,parentCwd:cwd,running:false,external})
    })
  })
  return rows
}, highlight=(text:unknown,term:string)=>{if(!term)return text;const parts=String(text).split(new RegExp(`(${term.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')})`,'ig'));return parts.map((part,i)=>i%2?jsx('mark',{children:part},i):part)}
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
// The terminal verdict of an ENDED subagent, read from the host's own
// `subagentTiming` projection and nothing else. `lastTurnCompleted` is a
// three-way fact and all three arms matter: `true` is a turn the host closed
// with `reason.kind === 'completed'`, `false` is every other close (a user stop
// arrives as `aborted`, alongside error / blocked / max-tokens / crash-repair),
// and a missing field is no verdict at all — no turn has ended yet, a turn is
// open right now, or the host publishes no verdict: the projection itself is
// already there on 0.1.5-rc.3 and 0.1.6-alpha.2, but as `{ settledMs, active? }`
// only — the field, folded from the durable `turn/end` reason, first appears on
// 0.1.7-alpha.1, so on those hosts absence stays absence. Absence is never
// upgraded to "completed". An interval still marked `active` yields nothing
// either, so a stale running bit cannot paint a live child with a terminal badge.
export const terminalOf=(row:SubagentRow|undefined)=>{const timing=row?.projectionValues?.subagentTiming,completed=timing?.lastTurnCompleted;if(completed!==true&&completed!==false)return undefined;if(timing?.active!==undefined)return undefined;return completed?'normal':'abnormal'}
// The row marker's extra class: a running row keeps its existing indicator
// untouched (empty suffix), and only a row that has ended AND carries a verdict
// gains one — so a host without the projection renders the byte-identical
// `dsh-sam-dot` element this plugin rendered before the feature existed.
export const terminalClass=(row:SubagentRow|undefined)=>{if(row?.running)return '';const ended=terminalOf(row);return ended===undefined?'':` dsh-sam-dot-${ended}`}
// The same verdict as readable text for `title`/`aria-label` (zh + en), or
// undefined so the marker carries no tooltip at all when there is no verdict.
export const terminalTitle=(tr:Tr,row:SubagentRow|undefined)=>{if(row?.running)return undefined;const ended=terminalOf(row);return ended===undefined?undefined:ended==='normal'?tr('end.normalNamed',{name:row?.name}):tr('end.abnormalNamed',{name:row?.name})}
// The right-sidebar action shared by both presentation surfaces (the manager
// panel row and the active float). `addressOf` is the capability probe: `null`
// means the host exposes the right-sidebar face but this row has no usable
// address, so the button renders disabled with a readable reason; `undefined`
// means the host exposes no usable right-sidebar face at all, and no button is
// rendered. The distinction exists because those faces register asynchronously
// (dsh 0.1.7-rc.1 publishes sidebarRight after a client plugin's apply runs), so
// the caller re-probes per row instead of deciding visibility once. The click
// always stops propagation so the row's own "open in the main conversation"
// default never runs, and a wiring failure never surfaces as an exception.
export const asideButton=(options:{tr:Tr,row:SubagentRow,addressOf?:((row:SubagentRow)=>string|null|undefined)|null,open?:((address:string)=>boolean)|null,compact?:boolean,onOpened?:()=>void})=>{
  const addressOf=options.addressOf
  if(typeof addressOf!=='function')return null
  const tr=options.tr
  let address=null
  try{address=addressOf(options.row)}catch(error){console.warn('subagent-workspace-ui: sidebar address lookup failed',error);address=null}
  if(address===undefined)return null
  return jsx('button',{type:'button',className:options.compact?'dsh-sam-side-btn dsh-sam-side-btn-compact':'dsh-sam-side-btn',disabled:!address,title:address?tr('openInSidebar'):tr('openInSidebarUnavailable'),'aria-label':address?tr('openInSidebar.named',{name:options.row.name}):tr('openInSidebarUnavailable'),onClick:event=>{event.stopPropagation();if(!address)return;if(typeof options.open==='function'&&options.open(address)===true){if(typeof options.onOpened==='function')options.onOpened();return}window.alert(tr('openInSidebarFailed'))},children:'◫'})
}
// ---------------------------------------------------------------- external --
// Everything below concerns rows whose catalog mode is `'external'`: a run of a
// dsh 0.2.1 provider without `prepareContinuable` (claude-code / codex). Such a
// child has NO local Session — its id is a branded `randomUUID()`, so `byId[id]`
// never exists, the host's `activity` for it is the constant `'inactive'`, and
// every session-derived surface (live output, prompt preview, usage, timing) is
// empty or wrong for it. The only authoritative live signal is the lifecycle pair
// the host entry records; `externalLedgerOf` is the single reader of that payload.
export const isExternalRow=(row:{mode?:string}|undefined)=>row?.mode==='external'
export const isExternalMode=(mode:string|undefined)=>mode==='external'
// The provider name as the host publishes it, or nothing. The payload carries the
// registered provider id (`claude-code`, `codex`); anything unreadable is dropped
// rather than guessed, so the panel falls back to the family name alone.
export const providerIdOf=(value:unknown)=>{
  if(typeof value!=='string')return undefined
  const clean=value.trim()
  return /^[a-z0-9][a-z0-9._-]*$/i.test(clean)&&clean.length<=48?clean:undefined
}
// One lifecycle payload, folded per child id. A child may have several terminal
// edges in one process (a one-shot delegation repeated under the same id is not
// possible for external runs, but a re-delegation can reuse a catalog label), so
// the LATEST edge wins and `historyCount` keeps the fact that more than one
// exists instead of hiding it.
export const externalStatesOf=(payload:ExternalLedger|null|undefined)=>{
  const states:Record<string, ExternalState>={}
  if(!payload||payload.ok===false)return states
  const active=Array.isArray(payload.active)?payload.active:[]
  const ended=Array.isArray(payload.ended)?payload.ended:[]
  const rankOf=run=>typeof run?.seq==='number'?run.seq:0
  const finished=[...ended].filter(run=>run&&typeof run.id==='string').sort((a,b)=>rankOf(a)-rankOf(b))
  for(const run of finished){
    const previous=states[run.id]
    states[run.id]={status:'ended',provider:providerIdOf(run.provider),runId:typeof run.runId==='string'?run.runId:undefined,startedAt:run.startedAt,endedAt:run.endedAt,stopReason:typeof run.stopReason==='string'?run.stopReason:undefined,durationMs:typeof run.durationMs==='number'&&Number.isFinite(run.durationMs)?Math.max(0,run.durationMs):undefined,historyCount:(previous?.historyCount||0)+1}
  }
  for(const run of active){
    if(!run||typeof run.id!=='string')continue
    const previous=states[run.id]
    if(previous&&previous.status==='running')continue
    // A live edge outranks every terminal one for the same id: the child is
    // running right now, whatever an earlier epoch of it did.
    states[run.id]={status:'running',provider:providerIdOf(run.provider),runId:typeof run.runId==='string'?run.runId:undefined,startedAt:run.startedAt,historyCount:previous?.historyCount||0}
  }
  return states
}
// The stop-reason vocabulary the host publishes (`SubagentResult['stopReason']`),
// each with its own label. An unknown value keeps its raw string in the tooltip
// but is labelled generically, so a backend-added reason can never be mistaken
// for a failure or a success.
const STOP_REASONS=['completed','aborted','error','refusal','max-tokens']
export const externalStopLabel=(tr:Tr,stopReason:string|undefined)=>{
  if(!stopReason)return tr('ext.stop.unknown')
  return STOP_REASONS.includes(stopReason)?tr(`ext.stop.${stopReason}`):tr('ext.stop.unknown')
}
// The engine family line: the host's provider id plus, for the two providers
// this feature was written for, their display names. Everything else is shown
// verbatim from the host — never mapped onto a known engine.
export const externalEngineName=(tr:Tr,provider:string|undefined)=>!provider?tr('ext.engineUnknown'):provider==='claude-code'?tr('ext.engine.claudeCode'):provider==='codex'?tr('ext.engine.codex'):provider
// The one external status line used by the row, the details block and the float.
// `measured` says where the fact came from so a reader can tell an observed edge
// from the absence of one; `unknown` is stated, never rendered as ended/running.
export const externalStatusText=(tr:Tr,state:ExternalState|undefined)=>{
  if(!state)return tr('ext.status.unknown')
  if(state.status==='running')return state.provider?tr('ext.status.runningEngine',{engine:externalEngineName(tr,state.provider)}):tr('ext.status.running')
  if(state.status==='ended'){
    const reason=externalStopLabel(tr,state.stopReason)
    const duration=typeof state.durationMs==='number'?tr('ext.duration',{seconds:Math.max(0,Math.round(state.durationMs/1000))}):null
    return duration?tr('ext.status.endedDetail',{reason,duration}):tr('ext.status.ended',{reason})
  }
  return tr('ext.status.unknown')
}
// Tooltip/aria for the same fact, so the marker never claims more than the text.
export const externalStatusTitle=(tr:Tr,state:ExternalState|undefined)=>{
  if(!state)return tr('ext.title.unknown')
  if(state.status==='running')return tr('ext.title.running',{engine:externalEngineName(tr,state.provider)})
  if(state.status==='ended')return tr('ext.title.ended',{reason:externalStopLabel(tr,state.stopReason),engine:externalEngineName(tr,state.provider)})
  return tr('ext.title.unknown')
}
// The marker class for an external row. It deliberately reuses the existing dot
// vocabulary — a running ring only for a measured running edge — and adds the
// external accent for the two non-running arms, which take no colour from the
// session-derived terminal verdicts (those do not exist for an external child).
export const externalDotClass=(state:ExternalState|undefined)=>{
  if(state?.status==='running')return ' dsh-sam-dot-ext-running'
  return ' dsh-sam-dot-ext'
}
// The stop target of a row, or null when a row may not be stopped by this plugin.
// Local rows keep their exact existing path (`liveBindingFor` → session); an
// external row has no session face and is stopped through the host entry, whose
// id is the run id — the only handle that names one execution rather than a
// catalog row that may have run several times.
export const externalStopTargetOf=(row:SubagentRow|undefined,external:ExternalStates|undefined)=>{
  if(!isExternalRow(row))return null
  const state=external?.[row.id]
  if(!state||state.status!=='running'||!state.runId)return null
  return {runId:state.runId,id:row.id}
}
