import { css } from './styles'
import type { Prefs, TabDef } from './types'
if (!document.querySelector('style[data-plugin-css="dsh-subagent-workspace-ui"]')) { const tag=document.createElement('style'); tag.dataset.pluginCss='dsh-subagent-workspace-ui'; tag.textContent=css; document.head.appendChild(tag) }
export const DAY=86400000, PAGE=40, key='dsh-subagent-workspace-ui/preferences', defaultTabs:TabDef[]=[{id:'all',nameKey:'tab.all',regex:'__ALL__'},{id:'other',nameKey:'tab.other',regex:'__OTHER__'},{id:'preset-review',nameKey:'tab.audit',regex:'\\b(?:re[- ]?)?review\\b|\\baudit\\b|\\bverify\\b|\\bverification\\b|\\binspect\\b|审计|评审|复核|核查|验证'},{id:'preset-test',nameKey:'tab.test',regex:'\\btests?\\b|\\bspecs?\\b|测试'},{id:'preset-implement',nameKey:'tab.implement',regex:'\\bimplement(?:ation)?\\b|\\bfeatures?\\b|\\bdevelop(?:ment)?\\b|\\bfix(?:es|ed)?\\b|\\brepair\\b|实现|开发|修复|修改'},{id:'preset-planning',nameKey:'tab.planning',regex:'\\bplans?\\b|\\bplanning\\b|\\bdesign\\b|\\broadmap\\b|规划|计划|方案|设计'}]
export const DEFAULT_LIGHT_BG='#edf3fe', DEFAULT_DARK_BG='#1c2333'
export const load:()=>Prefs=()=>{try{return JSON.parse(localStorage.getItem(key))||{}}catch{return {}}}
