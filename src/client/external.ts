import { externalStatesOf } from './format'
import type { ExternalStates } from './types'
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
