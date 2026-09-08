import type { SessionsRuntime, Unsubscribe } from './types'
let sessionsRt:SessionsRuntime|null=null
export const NOOP:()=>Unsubscribe=()=>()=>{}
