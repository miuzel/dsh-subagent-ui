import { externalStatesOf, sessionEntitiesOf } from './format'
import type { ExternalStates, SessionEntities, SessionEntityAnswer } from './types'
// The browser half of the external-agent channel. The host entry watches the
// host's own `subagent/start` / `subagent/end` pair and serves it on one exact
// route; this module polls that route and nothing else. Rules that keep the
// channel honest:
// - Polling is demand-driven: the caller passes `enabled` (a catalog row with
//   mode 'external' exists) and NO timer runs otherwise, so a host without
//   external providers costs zero requests.
// - One poll in flight at a time; a slow host can never stack requests.
// - A failed poll keeps the previous answer rather than inventing one: an
//   unreachable route means "status unavailable", which the reader renders as
//   `unknown`, not as "ended".
// - The interval belongs to the caller's effect: a session switch, a panel close
//   or the plugin's own disposal tears it down with the component.
// - The URL is the browser-visible path, which on a host with the official
//   connection service is served by the authenticated `/api` channel: the
//   browser's own session cookie admits it, so `credentials: 'same-origin'` is
//   set and NO token is ever assembled here (the channel answers 401 without a
//   credential, which the reader already renders as `unknown`).
const EXTERNAL_POLL_MS=2500
const EXTERNAL_STATUS_URL='/api/dsh-subagent-workspace-ui/external-status'
const EXTERNAL_STOP_URL='/api/dsh-subagent-workspace-ui/external-stop'
const SESSION_ENTITY_URL='/api/dsh-subagent-workspace-ui/session-entity'
export function useExternalStatus(enabled:boolean){
  const [payload,setPayload]=React.useState(null),[failed,setFailed]=React.useState(false)
  React.useEffect(()=>{
    if(!enabled){setFailed(false);return}
    let alive=true,inFlight=false
    const fetchOnce=async()=>{
      if(!alive||inFlight)return
      inFlight=true
      try{
        const response=await fetch(EXTERNAL_STATUS_URL,{headers:{accept:'application/json'},cache:'no-store',credentials:'same-origin'})
        if(!response.ok)throw new Error(`HTTP ${response.status}`)
        const data=await response.json()
        if(!alive)return
        setPayload(data&&data.ok!==false?data:null)
        setFailed(false)
      }catch(error){
        if(!alive)return
        console.warn('subagent-workspace-ui: external-agent status is unavailable',error)
        setFailed(true)
      }finally{
        inFlight=false
      }
    }
    fetchOnce()
    const timer=setInterval(fetchOnce,EXTERNAL_POLL_MS)
    return()=>{alive=false;clearInterval(timer)}
  },[enabled])
  const states:ExternalStates=React.useMemo(()=>externalStatesOf(payload),[payload])
  return {states,failed}
}
// The existence probe. "Does this child still own a session directory?" is a
// question only the host can answer, and it is the one fact that separates a
// child this plugin deleted (its directory is gone, while the host's catalog —
// append-only — keeps listing it) from a child that is merely not running.
//
// The conservative direction is NAMED in the type: the result is a SET of ids
// that were POSITIVELY found absent, so every failure mode (route missing, 401,
// network, unparsable body, malformed lists, an empty request) resolves to the
// empty set — and an empty set hides nothing. There is no "deleted by default".
//
// Batching: one request names every candidate id as `?id=` (the GET above is
// the one the ledger poll already makes; this route is fetched only when the
// candidate set CHANGES, not per row and not per poll — the caller memoizes on
// the joined id list, and once an id is known absent it stays in that set).
//
// The `phase` argument is the SECOND trigger, and it exists because the
// candidate list alone cannot express the one event that makes a stale answer
// wrong: a deletion performed by this panel. Deleting removes the child's
// directory but changes nothing the browser can see (`byId` and the append-only
// catalog are rebuilt by the host from the parent's log, so the key of every
// candidate id is unchanged), so a probe keyed only on ids would keep answering
// with the pre-deletion verdict until the panel was reopened — i.e. remounted.
// The caller therefore bumps a counter once a delete is CONFIRMED by the host,
// and the same batched request is replayed over the CURRENT candidate set only
// (no extra ids, no per-row request, no timer). Re-probing cannot make a row
// disappear on its own: every failure mode still folds to "show" (see
// sessionEntitiesOf), so a replay can only ever confirm what the host now says.
const SESSION_ENTITY_BATCH=100
const SESSION_ENTITY_CACHE_LIMIT=500
export function useSessionEntities(ids:string[],phase?:number){
  const key=[...new Set((ids||[]).filter(id=>typeof id==='string'&&id))].sort().join(',')
  const [absent,setAbsent]=React.useState<SessionEntities>(new Set)
  React.useEffect(()=>{
    if(!key)return
    let alive=true
    const wanted=key.split(',')
    const fetchBatch=async batch=>{
      const query=batch.map(id=>`id=${encodeURIComponent(id)}`).join('&')
      const response=await fetch(`${SESSION_ENTITY_URL}?${query}`,{headers:{accept:'application/json'},cache:'no-store',credentials:'same-origin'})
      if(!response.ok)throw new Error(`HTTP ${response.status}`)
      return response.json()
    }
    const run=async()=>{
      const answers:SessionEntityAnswer[]=[]
      for(let at=0;at<wanted.length;at+=SESSION_ENTITY_BATCH){
        const batch=wanted.slice(at,at+SESSION_ENTITY_BATCH)
        try{
          answers.push(await fetchBatch(batch))
        }catch(error){
          if(!alive)return
          // One failed batch says nothing about it; the others still answer.
          console.warn('subagent-workspace-ui: session existence is unavailable for one batch',error)
        }
      }
      if(!alive)return
      const found=sessionEntitiesOf(answers)
      if(!found.size)return
      // Newest answers win; the set is the browser's memory of "positively
      // absent", bounded by the same cap the deletion memory uses.
      setAbsent(previous=>{
        const next=new Set<string>(previous)
        for(const id of found){next.delete(id);next.add(id)}
        const all=[...next]
        return new Set<string>(all.slice(Math.max(0,all.length-SESSION_ENTITY_CACHE_LIMIT)))
      })
    }
    const task=run()
    if(task&&typeof task.catch==='function')task.catch(error=>console.warn('subagent-workspace-ui: session existence probe failed',error))
    return()=>{alive=false}
  },[key,phase])
  return absent
}
// One stop request. The host resolves the run itself (the browser never names a
// parent) and reports one of a small set of outcomes; every non-success is
// surfaced to the caller so the panel can say why nothing stopped, instead of
// leaving a spinner that quietly disappears.
export async function requestExternalStop(runId:string){
  try{
    const response=await fetch(EXTERNAL_STOP_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId}),credentials:'same-origin'})
    let data=null
    try{data=await response.json()}catch{}
    return {ok:response.ok&&Boolean(data&&data.ok),status:response.status,error:data&&data.error?String(data.error):`HTTP ${response.status}`}
  }catch(error){
    return {ok:false,status:0,error:error&&error.message?String(error.message):'network'}
  }
}
