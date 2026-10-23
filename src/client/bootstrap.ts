import { css } from './styles'
import type { Prefs, TabDef } from './types'
if (!document.querySelector('style[data-plugin-css="dsh-subagent-workspace-ui"]')) { const tag=document.createElement('style'); tag.dataset.pluginCss='dsh-subagent-workspace-ui'; tag.textContent=css; document.head.appendChild(tag) }
export const DAY=86400000, PAGE=40, key='dsh-subagent-workspace-ui/preferences', defaultTabs:TabDef[]=[{id:'all',nameKey:'tab.all',regex:'__ALL__'},{id:'other',nameKey:'tab.other',regex:'__OTHER__'},{id:'preset-review',nameKey:'tab.audit',regex:'\\b(?:re[- ]?)?review\\b|\\baudit\\b|\\bverify\\b|\\bverification\\b|\\binspect\\b|审计|评审|复核|核查|验证'},{id:'preset-test',nameKey:'tab.test',regex:'\\btests?\\b|\\bspecs?\\b|测试'},{id:'preset-implement',nameKey:'tab.implement',regex:'\\bimplement(?:ation)?\\b|\\bfeatures?\\b|\\bdevelop(?:ment)?\\b|\\bfix(?:es|ed)?\\b|\\brepair\\b|实现|开发|修复|修改'},{id:'preset-planning',nameKey:'tab.planning',regex:'\\bplans?\\b|\\bplanning\\b|\\bdesign\\b|\\broadmap\\b|规划|计划|方案|设计'}]
export const DEFAULT_LIGHT_BG='#edf3fe', DEFAULT_DARK_BG='#1c2333'
export const load:()=>Prefs=()=>{try{return JSON.parse(localStorage.getItem(key))||{}}catch{return {}}}
// The bounded memory of deleted external children. The host's catalog never
// shrinks and an external child has no Session, so "deleted" is a fact only this
// browser observed; it is kept here, next to `archived`, under the same key, and
// survives a refresh. The cap is what keeps it from accreting forever: the list
// is a newest-last string array, so the oldest entries fall off the front.
export const EXTERNAL_REMOVED_LIMIT=500
export const externalRemovedCap:(list:string[]|undefined)=>string[]=list=>{const seen=new Set<string>();const kept=(Array.isArray(list)?list:[]).filter(id=>typeof id==='string'&&id&&!seen.has(id)&&Boolean(seen.add(id)));return kept.length>EXTERNAL_REMOVED_LIMIT?kept.slice(kept.length-EXTERNAL_REMOVED_LIMIT):kept}
// Adding is idempotent and moves the id to the newest end, so a re-deleted id
// never pins an old position (and can therefore never become unevictable).
export const externalRemovedAdd:(list:string[]|undefined,id:string)=>string[]=(list,id)=>externalRemovedCap([...(Array.isArray(list)?list:[]).filter(x=>x!==id),id])
