// @ts-nocheck
import { resolver } from "../islands/resolver/resolver.svelte.ts";
import { bisectCtrl } from "../islands/bisect/bisect.svelte.ts";
import { cmdkCtrl } from "../islands/cmdk/cmdk.svelte.ts";
import { detailCtrl } from "../islands/detail/detail.svelte.ts";
import { bisectDrawerCtrl } from "../islands/bisectdrawer/bisectdrawer.svelte.ts";
import { loadSettings, saveSettings } from "../islands/settings/settings.svelte.ts";
import { sidebarCtrl } from "../islands/sidebar/sidebar.svelte.ts";
import { workdirCtrl } from "../islands/workdir/workdir.svelte.ts";
import { commitMenuCtrl } from "../islands/commitmenu/commitmenu.svelte.ts";
import { dashboardCtrl } from "../islands/dashboard/dashboard.svelte.ts";
import { repoSummaryCtrl } from "../islands/reposummary/reposummary.svelte.ts";
// Hidden Easter egg — see its own header doc + this file's click-counter
// right after gaze()/the idle-sleep interval below.
import { tamaGalleryCtrl } from "../islands/tamagallery/tamagallery.svelte.ts";
// Typed client for the one raw `tinvoke()` call below that needs it
// (globalUndo()'s stash-undo branch) — see that function's own comment for
// why only that branch uses it instead of another `tinvoke()`.
import { commands } from "../ipc/bindings";
// TamaMascot.set() below plays a short synthesized chime on a real state
// change via STATE_SOUND — see sound.ts's own header for why this is a leaf
// module main.ts imports FROM, never the reverse.
import { playTamaSound, STATE_SOUND } from "./sound.ts";
import { createTamaPresentation } from "../tama/actor.ts";
import { TAMA_SPRITE_POSES } from "../tama/types.ts";
"use strict";
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const TAU=Math.PI*2;
const FONT_UI=getComputedStyle(document.body).fontFamily;
const app=$("#app");

/* Portraits rendered from the same Kirara GLB used by the live sidebar
   actor. Static surfaces share these transparent captures so every Tama
   appearance stays visually consistent without creating many WebGL
   contexts at once. Regenerate them with `pnpm tama:portraits`. */
const TAMA_IMG={
  hero:"/tama/portraits/hero.png",
  curious:"/tama/portraits/curious.png",
  sleep:"/tama/portraits/sleep.png",
  thinking:"/tama/portraits/thinking.png",
  shocked:"/tama/portraits/shocked.png",
  alarm:"/tama/portraits/alarm.png",
  happy:"/tama/portraits/happy.png",
  confident:"/tama/portraits/confident.png",
};

/* ============================================================
   1) DESIGN TOKENS the canvas paints with (kept in sync w/ CSS)
   ============================================================ */
const NCOL=7;
const LANE_COLORS=new Array(NCOL).fill("#888");
let theme={bg:"#14100A",panel:"#221B12",elevated:"#31281A",border:"#4C3E2A",text:"#FBF3E2",muted:"#BBAB8E",accent:"#F5B843",accent2:"#88CFBA",warning:"#F2923E",success:"#A6D66C",danger:"#F2715B"};
function readTheme(){
  const cs=getComputedStyle(document.documentElement), v=n=>cs.getPropertyValue(n).trim();
  ["bg","panel","elevated","border","text","muted","accent","accent2","warning","success","danger"].forEach(k=>{const c=v("--"+k);if(c)theme[k]=c;});
  for(let i=0;i<NCOL;i++){const c=v("--l"+i);if(c)LANE_COLORS[i]=c;}
  if(typeof dirty!=="undefined")dirty=true;
}
const PADX=18, ROW_H_BASE=26, LANE_W_BASE=14, DOT_R_BASE=4.6;
// Right-edge gutter reserved for the sha (was the ONLY thing living there —
// hence the old bare "96") plus the author-name preview added alongside it
// (see draw()'s row loop / authorOf() above): 96 for the sha itself, 8px gap,
// 100px budget for the (truncated) author name.
const AUTHOR_GUTTER=96+8+100;
// Smallest width draw() will ever leave for the subject/chips column before
// the right-anchored author/sha fields start — see draw()'s own comment on
// clamping `tx` against it. Below this, text stops being legible anyway; the
// point is bounding how far `tx` can be pushed by an extremely wide stretch
// of history, not fitting more text in.
const MIN_SUBJECT_W=40;

/* ============================================================
   2) SYNTHETIC DAG — Structure-of-Arrays, seeded & deterministic.
      Replace generateGraph() with a libgit2-fed topo layout later;
      draw() only ever touches the visible row window, so cost is
      O(visible rows), never O(N). This is the M0 perf story.
   ============================================================ */
let G=null;
/* When running inside Tauri, BACKEND holds the real graph payload from Rust —
   grown incrementally as "graph-batch" events stream in (see
   startGraphStream()/onGraphBatch() below), never one big blob from a single
   load_graph response anymore; when null (e.g. opened in a plain browser for
   design work) the synthetic generator below is used instead, so this file
   works in both places. */
let BACKEND=null;
// The request id (THIS file's own monotonic counter — see
// startGraphStream()'s own doc comment for why it's caller-owned, not
// server-generated) for whichever stream is CURRENTLY meant to be populating
// BACKEND. A batch whose own `generation` doesn't match this is stale
// (superseded by a later startGraphStream() call — repo switch, manual
// refresh, a "repo-changed" reload) and must be silently dropped rather than
// corrupting the graph that's actually current.
let graphGeneration=0;
// Set by reloadGraph() when it wants the previously-selected row/pinned
// workdir row restored once the CURRENT stream finishes (see
// onGraphBatch()'s own `done` handling) — a fresh openRepo() never sets this,
// since there's nothing to restore on a brand new open.
let pendingReselect=null;
// Last time onGraphBatch() forced a real (not just dirty-flagged) draw() —
// see its own doc comment on why a throttled explicit draw is needed to keep
// the canvas painting incrementally during a burst of rapid "graph-batch"
// events, instead of only catching up once the burst quiets down.
let lastForcedDrawAt=0;
export let CUR_REPO=null;   // absolute path of the open repo; commit_detail(path, sha) needs it — exported (live binding) for the Svelte islands via bridge.ts
const IN_TAURI = !!(window.__TAURI__ && window.__TAURI__.core);
const tinvoke = (cmd, args={}) => window.__TAURI__.core.invoke(cmd, args);
let undoBusy=false;
function relTime(t){ let s=Math.max(0,Math.floor(Date.now()/1000-t));
  if(s<60)return s+"s ago"; let m=(s/60)|0; if(m<60)return m+"m ago"; let h=(m/60)|0; if(h<24)return h+"h ago";
  let d=(h/24)|0; if(d<30)return d+"d ago"; let mo=(d/30)|0; if(mo<12)return mo+"mo ago"; return ((mo/12)|0)+"y ago"; }
// Absolute counterpart to relTime() above — "X ago" alone doesn't answer
// "which actual day/time was this", so the detail panel shows both side by
// side (see detail.svelte.ts's commitMeta()). Viewer's local timezone/locale,
// same as every other absolute-date spot in the app already does inline
// (Sidebar.svelte/FilterRepo.svelte/Plumbing.svelte's `new
// Date(ts*1000).toLocaleString()` tooltips) — this is just that same
// convention pulled out somewhere shared, since detail.svelte.ts needs it too.
function absTime(t){ return new Date(t*1000).toLocaleString(); }
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const MSGS=["Refactor lane allocator","Fix off-by-one in viewport cull","Add DPR-correct resize","Merge branch 'feat/snapshot-ui'","Cache typed arrays across frames","Throttle hover hit-test","Batch edges by lane colour","Seal backup ref before undo","Tidy scrollbar drag math","Bench: 10k in 0.7s","Curved merge edges","Pause mascot on interaction","WIP: comet trails","Guard filter-repo behind typed confirm","Reflow visible rows on rewind","Wire login form to API","Add rate limiting to token store","Extract swimlane module","Teach bisect to read BISECT_LOG","rerere: reuse recorded resolution"];
function hhex(r){ if(BACKEND)return BACKEND.rows[r]?BACKEND.rows[r].sha:"";
  let h=(Math.imul(r^0x9e3779b9,2654435761))>>>0;return("0000000"+h.toString(16)).slice(-7);}
function msgOf(r){ if(BACKEND)return BACKEND.rows[r]?BACKEND.rows[r].subject:"";
  return r===0?"Head of main — you are here":MSGS[(Math.imul(r,2246822519)>>>4)%MSGS.length];}
// Author name preview next to each row's own sha (see draw()'s row loop) —
// same dual-mode "real BACKEND field, or a synthetic deterministic pick"
// shape as hhex/msgOf above. AUTHORS itself is declared further down this
// file (a `const`, not hoisted) — safe to reference here anyway since this
// function's BODY only actually runs from draw()'s row loop, well after the
// whole module (AUTHORS included) has finished evaluating; same reasoning
// this file's own bridge.ts already documents for its live re-exports.
function authorOf(r){ if(BACKEND)return BACKEND.rows[r]?BACKEND.rows[r].an.n:"";
  return AUTHORS[(Math.imul(r,2654435761)>>>5)%AUTHORS.length].n;}
function fakeAgo(r){const m=r*2+3;return m<60?m+"m":m<1440?Math.floor(m/60)+"h":Math.floor(m/1440)+"d";}

function generateGraph(N){
  const rng=mulberry32(0xC0FFEE^N);
  const commitLane=new Int16Array(N), commitColor=new Uint8Array(N), isMerge=new Uint8Array(N);
  const gaps=new Array(N); for(let i=0;i<N;i++) gaps[i]=[];
  const slotColor=[0]; let nextColor=1, forceLane=-1;
  const firstFree=()=>{let l=0;while(slotColor[l]!==undefined&&slotColor[l]!==-1)l++;return l;};
  for(let r=0;r<N;r++){
    const occ=[]; for(let l=0;l<slotColor.length;l++) if(slotColor[l]>=0) occ.push(l);
    if(occ.length===0){slotColor[0]=0;occ.push(0);}
    let cl;
    if(forceLane>=0&&slotColor[forceLane]>=0){cl=forceLane;forceLane=-1;}
    else cl=(rng()<0.6)?occ[0]:occ[(rng()*occ.length)|0];
    commitLane[r]=cl; commitColor[r]=slotColor[cl];
    const canFork=r<N-3&&occ.length<7, doFork=canFork&&rng()<0.06;
    let convLane=-1;
    if(!doFork&&occ.length>1&&r<N-2&&rng()<0.05){const cand=occ.filter(l=>l!==cl&&l!==0);if(cand.length)convLane=cand[(rng()*cand.length)|0];}
    const forkLane=doFork?firstFree():-1;
    for(let i=0;i<occ.length;i++){const l=occ[i];
      if(l===convLane) gaps[r].push({top:l,bottom:cl,color:slotColor[l]});
      else gaps[r].push({top:l,bottom:l,color:slotColor[l]});}
    if(forkLane>=0){isMerge[r]=1;const c=(nextColor++)%NCOL;slotColor[forkLane]=c;gaps[r].push({top:cl,bottom:forkLane,color:c});}
    if(convLane>=0){slotColor[convLane]=-1;forceLane=cl;}
  }
  let total=0; for(let r=0;r<N;r++) total+=gaps[r].length;
  const gapStart=new Int32Array(N+1), gapTop=new Int16Array(total), gapBot=new Int16Array(total), gapColor=new Uint8Array(total);
  let idx=0; for(let r=0;r<N;r++){gapStart[r]=idx;const a=gaps[r];for(let j=0;j<a.length;j++){gapTop[idx]=a[j].top;gapBot[idx]=a[j].bottom;gapColor[idx]=a[j].color;idx++;}}
  gapStart[N]=idx;
  const BR=["feat/inline-diff","fix/lane-cull","topic/rerere","exp/canvas2","ci/bench","feat/snapshot-ui"];
  const refs=new Array(N).fill(null); refs[0]={label:"main",kind:"head"};
  for(let r=40;r<N;r+=380+((r*131)%520)) refs[r]={label:"v0."+(1+((r/1400)|0))+"."+((r/220)%9|0),kind:"tag"};
  let bn=0; for(let r=1;r<N;r++){if(commitLane[r]>0&&!refs[r]&&r%223===0&&bn<48){refs[r]={label:BR[bn%BR.length],kind:"branch"};bn++;}}
  // allRefs mirrors refs above (a 0- or 1-element array) EXCEPT at row 40,
  // deliberately seeded with a second co-located tag — the one place this
  // synthetic dataset actually exercises the "more than one ref per commit"
  // case, so the Settings "show all tags" toggle has something real to
  // demo in browser design mode (refs[40] itself stays single-element, so
  // the setting OFF still shows exactly one chip there, matching a fresh repo).
  const allRefs=refs.map(r=>r?[r]:[]);
  if(refs[40]) allRefs[40]=[refs[40],{label:"v0.2.9-rc1",kind:"tag"}];
  const snapRows=[]; const snapTs={};
  for(let r=6;r<N;r+=38+((r*97)%46)){snapRows.push(r);snapTs[r]=fakeAgo(r);}
  // High-water mark of lane slots ever allocated — slotColor's length only
  // ever grows (a freed slot, marked -1, gets REUSED via firstFree(), not
  // shrunk away), same "running max, never decreases" property Rust's own
  // LayoutBuilder.lane_count tracks for the real backend (see model.rs's
  // GraphBatch.laneCount). recomputeLayout() reads this to size panning
  // range — without it here, G.laneCount was undefined in design mode,
  // turning state.maxPanX into NaN.
  const laneCount=slotColor.length;
  return {N,commitLane,commitColor,isMerge,gapStart,gapTop,gapBot,gapColor,refs,allRefs,snapRows,snapTs,laneCount};
}

/* ============================================================
   3) RENDER STATE
   ============================================================ */
const cv=$("#cv"), ctx=cv.getContext("2d"), wrap=$("#canvasWrap");
const layout={zoom:1,rowH:ROW_H_BASE,laneW:LANE_W_BASE,dotR:DOT_R_BASE,chipFont:"11px "+FONT_UI,contentH:0};
// panX/panTarget/maxPanX: HORIZONTAL counterpart to scrollTop/scrollTarget/
// maxScroll above — a repo with an extremely wide stretch of history (many
// simultaneously open branch lanes, e.g. hundreds of concurrently active
// lanes in a real large project's full history) can need far more width than
// any real window has; without a way to pan sideways, lanes past the visible
// edge were simply unreachable, AND (see draw()'s own comment on tx) forced
// the subject/author/sha text into an ever-shrinking sliver until it
// started rendering on top of itself. Same eased-toward-target tick()
// treatment as scrollTop.
const state={scrollTop:0,scrollTarget:0,maxScroll:0,panX:0,panTarget:0,maxPanX:0,selectedRow:-1,hoverRow:-1,drag:null,pointerActive:false,isInteracting:false,stress:false,selectAlpha:0,hoverAlpha:0};
// Row-highlight fade: eased toward its target each tick() (see the
// scrollTop lerp just below tick's own definition for the same recipe) so
// selecting/hovering a row fades the tint in instead of snapping to full
// alpha — purely a canvas-side effect since the graph has no DOM/CSS to
// transition. Checked once, like TamaMascot's own `this.reduced` (this file
// has no live matchMedia listener anywhere, by the same precedent).
const REDUCE_MOTION=matchMedia("(prefers-reduced-motion:reduce)").matches;
const view={cssW:0,cssH:0,dpr:1};
const perf={last:performance.now(),frames:0,accum:0,fps:0,lastDrawMs:0};
let dirty=true, lastInteracting=false;
const edgePaths=new Array(NCOL);
const laneX=(l)=>PADX+l*layout.laneW-state.panX;
const clampScroll=(v)=>v<0?0:(v>state.maxScroll?state.maxScroll:v);
const clampPan=(v)=>v<0?0:(v>state.maxPanX?state.maxPanX:v);

function recomputeLayout(){
  const z=layout.zoom;
  layout.rowH=Math.max(11,Math.round(ROW_H_BASE*z));
  layout.laneW=LANE_W_BASE*(0.85+0.15*z);
  layout.dotR=DOT_R_BASE*(0.85+0.15*z);
  layout.chipFont=Math.round(11*Math.min(1.3,z))+"px "+FONT_UI;
  layout.contentH=(G?G.N:0)*layout.rowH;
  // +bandH(): the pinned header steals bandH() px of on-screen vertical
  // space from every real row (see bandH()'s own comment + the doc block
  // right above drawWorkdirBand()) but reserves NO extra scroll room for
  // itself — without this term the LAST row's y-position at
  // scrollTop===maxScroll works out to exactly view.cssH (fully off-canvas,
  // unreachable/unclickable) whenever bandH()>0, i.e. on every repo with a
  // workdir panel (any open repo, or browser design-mode) that has more
  // commits than fit on screen. bandH() itself is hoisted (function
  // declaration below), so calling it here before its own definition is
  // safe — same reasoning as every other early call site.
  state.maxScroll=Math.max(0,layout.contentH+bandH()-view.cssH);
  state.scrollTarget=clampScroll(state.scrollTarget); state.scrollTop=clampScroll(state.scrollTop);
  // How far right panning is allowed to go: enough that the single WIDEST
  // lane seen anywhere in the whole loaded graph so far (G.laneCount — a
  // running high-water mark, not just what's in the current scroll window)
  // can be panned into view with the same left margin every other lane
  // starts with, and exactly 0 (no panning at all, laneX(l)===PADX+l*laneW
  // same as before this feature existed) whenever the graph is narrow enough
  // to fit already — the overwhelmingly common case.
  const widestLaneX=Math.max(0,((G?G.laneCount:0)-1))*layout.laneW;
  state.maxPanX=Math.max(0,widestLaneX-(view.cssW-PADX*2));
  state.panTarget=clampPan(state.panTarget); state.panX=clampPan(state.panX);
  dirty=true;
}
function resize(){
  const r=wrap.getBoundingClientRect(); view.cssW=r.width; view.cssH=r.height; view.dpr=window.devicePixelRatio||1;
  cv.width=Math.round(view.cssW*view.dpr); cv.height=Math.round(view.cssH*view.dpr);
  ctx.setTransform(view.dpr,0,0,view.dpr,0,0); recomputeLayout(); positionTicks();
}

/* ============================================================
   4) DRAW — virtualised pass. Offscreen rows are never touched.
   ============================================================ */
function draw(){
  const t0=performance.now();
  const {rowH,dotR}=layout, st=state.scrollTop, W=view.cssW, H=view.cssH, N=G.N, bh=bandH();
  ctx.setTransform(view.dpr,0,0,view.dpr,0,0);
  ctx.fillStyle=theme.bg; ctx.fillRect(0,0,W,H);
  if(N===0){ if(workdirAvailable()) drawWorkdirBand(); perf.lastDrawMs=performance.now()-t0; return; }
  const first=Math.max(0,Math.min(N-1,Math.floor(st/rowH)));
  const last=Math.max(0,Math.min(N-1,Math.floor((st+H)/rowH)));

  // bisect band (behind everything) — real rows are offset by +bh (see bandH())
  const B=bisectDrawerCtrl.active();
  if(B){ for(let r=first;r<=last;r++){ const y=r*rowH-st+bh;
    if(r>B.lo&&r<B.hi&&!bisectDrawerCtrl.skips.has(r)){ ctx.fillStyle=theme.warning; ctx.globalAlpha=0.12; ctx.fillRect(0,y,W,rowH); ctx.globalAlpha=1; } } }
  // Active cherry-pick/merge drag: legalPick/legalMerge already run per-hover
  // (pointermove, for the ghost tooltip's own reason text) — reused here
  // per-VISIBLE-ROW so every illegal drop target dims the same way the
  // bisect range already dims out-of-range rows below, leaving legal targets
  // (any non-ancestor row other than the source itself) the only ones at
  // full brightness while a drag is in flight.
  const DR=state.drag;

  // edges — one Path2D per lane colour
  for(let c=0;c<NCOL;c++) edgePaths[c]=null;
  const gStart=Math.max(0,first-1), gEnd=Math.min(N-2,last);
  // Track the widest lane touched anywhere in this window WHILE walking the
  // gap segments below (not just rows with a visible commit dot) — a branch
  // whose tip is scrolled off the top still keeps its line running straight
  // through every intervening gap (see layout.rs), so without this a window
  // with no branch-tip row of its own collapsed `tx` to lane 0 every frame,
  // squashing every row's subject/sha text against the graph regardless of
  // how many lanes were actually still open at this scroll position.
  let maxLane=0;
  for(let g=gStart;g<=gEnd;g++){
    const yTop=g*rowH+rowH*0.5-st+bh, yBot=(g+1)*rowH+rowH*0.5-st+bh, yMid=(yTop+yBot)*0.5;
    const s=G.gapStart[g], e=G.gapStart[g+1];
    for(let k=s;k<e;k++){const top=G.gapTop[k],bot=G.gapBot[k],col=G.gapColor[k];
      if(top>maxLane) maxLane=top; if(bot>maxLane) maxLane=bot;
      let p=edgePaths[col]; if(!p) p=edgePaths[col]=new Path2D();
      const xTop=laneX(top),xBot=laneX(bot);
      if(top===bot){p.moveTo(xTop,yTop);p.lineTo(xBot,yBot);}
      else{p.moveTo(xTop,yTop);p.bezierCurveTo(xTop,yMid,xBot,yMid,xBot,yBot);}}
  }
  ctx.lineWidth=Math.max(1.7,1.9*layout.zoom); ctx.lineJoin="round"; ctx.lineCap="round";
  for(let c=0;c<NCOL;c++){const p=edgePaths[c];if(p){ctx.strokeStyle=LANE_COLORS[c];ctx.stroke(p);}}

  for(let r=first;r<=last;r++) if(G.commitLane[r]>maxLane) maxLane=G.commitLane[r];
  // ADVERSARIALLY-FOUND FIX: an extremely wide stretch of history (many
  // simultaneously open branch lanes — hundreds is plausible for a large
  // real project's full history) used to push tx arbitrarily far right with
  // nothing bounding it, so the subject text's own starting x could land
  // PAST where the right-anchored author/sha fields begin — not just
  // scrolled off-canvas (which panning above now fixes) but genuinely
  // overlapping/garbling that fixed-position text every frame, for every row
  // in view, any time the window happened to touch that wide a stretch.
  // Clamping tx here keeps the subject column at least MIN_SUBJECT_W wide
  // (worse to read at extreme widths, never overlapping) regardless of how
  // far a lane actually extends — panning is how you reach/inspect lanes
  // that wide, not by widening this column past the point of collision.
  const tx=Math.min(laneX(maxLane)+dotR+14,W-AUTHOR_GUTTER-MIN_SUBJECT_W);

  ctx.textBaseline="middle"; ctx.font=layout.chipFont;
  for(let r=first;r<=last;r++){
    const y=r*rowH+rowH*0.5-st+bh, x=laneX(G.commitLane[r]), col=LANE_COLORS[G.commitColor[r]];
    const bisectDim = B && !(r>B.lo&&r<B.hi) && r!==B.good && r!==B.bad;
    const dragDim = DR && !(DR.op==="merge"?legalMerge(DR.source,r):legalPick(DR.source,r)).ok;
    const dim = bisectDim || dragDim;
    if(r===state.selectedRow){ ctx.fillStyle=theme.accent; ctx.globalAlpha=state.selectAlpha; ctx.fillRect(0,r*rowH-st+bh,W,rowH); ctx.globalAlpha=1;
      ctx.fillStyle=theme.accent; ctx.fillRect(0,r*rowH-st+bh,3,rowH); }
    else if(r===state.hoverRow){ ctx.fillStyle=theme.text; ctx.globalAlpha=state.hoverAlpha; ctx.fillRect(0,r*rowH-st+bh,W,rowH); ctx.globalAlpha=1; }
    if(B&&r===B.good){ctx.fillStyle=theme.success;ctx.fillRect(0,r*rowH-st+bh,3,rowH);}
    if(B&&r===B.bad){ctx.fillStyle=theme.danger;ctx.fillRect(0,r*rowH-st+bh,3,rowH);}
    if(bisectDrawerCtrl.cur!=null&&r===bisectDrawerCtrl.cur){ctx.fillStyle=theme.accent;ctx.fillRect(0,r*rowH-st+bh,3,rowH);}
    ctx.globalAlpha=dim?0.4:1;
    ctx.beginPath(); ctx.arc(x,y,dotR,0,TAU);
    if(G.isMerge[r]){ctx.fillStyle=theme.bg;ctx.fill();ctx.lineWidth=2;ctx.strokeStyle=col;ctx.stroke();}
    else{ctx.fillStyle=col;ctx.fill();}
    if(r===state.selectedRow){ctx.beginPath();ctx.arc(x,y,dotR+3.2,0,TAU);ctx.strokeStyle=theme.text;ctx.lineWidth=1.6;ctx.stroke();}
    else if(r===state.hoverRow){ctx.beginPath();ctx.arc(x,y,dotR+2.6,0,TAU);ctx.strokeStyle=theme.muted;ctx.lineWidth=1;ctx.stroke();}
    if(bisectDrawerCtrl.cur!=null&&r===bisectDrawerCtrl.cur&&r!==state.selectedRow){ctx.beginPath();ctx.arc(x,y,dotR+3.4,0,TAU);ctx.strokeStyle=theme.accent;ctx.lineWidth=2;ctx.stroke();}
    let cx=tx; ctx.font=layout.chipFont;
    // BUG FIX: a long tag/branch label (or, with "show every tag" on, several
    // chained onto one commit) used to draw at its full natural width with
    // nothing bounding cx afterward — same overlap class the tx-clamp above
    // already fixes for wide lane stretches, just triggered by chip content
    // instead of lane count. chipLimit mirrors tx's own reservation (leave at
    // least MIN_SUBJECT_W for the subject column before the author/sha
    // gutter starts) — drawChip now truncates a chip that would cross it, and
    // the loop below stops adding MORE chips once there's no room left at all.
    const chipLimit=W-AUTHOR_GUTTER-MIN_SUBJECT_W;
    if(showAllTags&&G.allRefs){ const list=G.allRefs[r]; for(let i=0;i<list.length&&cx<chipLimit;i++) cx=drawChip(cx,y,list[i].label,list[i].kind,chipLimit-cx)+8; }
    else { const ref=G.refs[r]; if(ref&&cx<chipLimit) cx=drawChip(cx,y,ref.label,ref.kind,chipLimit-cx)+8; }
    if(rowH>=15){
      // Reserve room for BOTH the author preview and the sha (AUTHOR_GUTTER
      // below) — previously only the sha itself (96px) was reserved, so
      // adding the author name here without widening this would have let a
      // long commit message visually collide with it.
      ctx.font=Math.round(12.5*Math.min(1.25,layout.zoom))+"px "+FONT_UI; ctx.fillStyle=theme.text; ctx.textAlign="left";
      let s=msgOf(r); const maxw=W-cx-AUTHOR_GUTTER;
      if(ctx.measureText(s).width>maxw){while(s.length>4&&ctx.measureText(s+"…").width>maxw)s=s.slice(0,-1);s+="…";}
      ctx.fillText(s,cx,y);
      ctx.fillStyle=theme.muted; ctx.textAlign="right"; ctx.font=Math.round(10.5*Math.min(1.2,layout.zoom))+"px ui-monospace,monospace";
      const sha=hhex(r), shaW=ctx.measureText(sha).width;
      // Author preview — right next to the sha, so who wrote a commit is
      // visible at a glance without opening its detail panel. Own (slightly
      // larger, UI-font-not-mono) style so it doesn't read as part of the
      // hash itself; truncated the same way the message above is.
      ctx.font=Math.round(11*Math.min(1.2,layout.zoom))+"px "+FONT_UI;
      let a=authorOf(r); const maxAuthorW=AUTHOR_GUTTER-96-8;
      if(ctx.measureText(a).width>maxAuthorW){while(a.length>1&&ctx.measureText(a+"…").width>maxAuthorW)a=a.slice(0,-1);a+="…";}
      ctx.fillText(a,W-14-shaW-8,y);
      ctx.font=Math.round(10.5*Math.min(1.2,layout.zoom))+"px ui-monospace,monospace";
      ctx.fillText(sha,W-14,y); ctx.textAlign="left";
    }
    ctx.globalAlpha=1;
  }
  drawWorkdirBand();
  if(state.drag) drawDragGhost();
  drawScrollbar(st,H,W);
  drawHScrollbar(H,W);
  perf.lastDrawMs=performance.now()-t0;
}
// The pinned "Uncommitted changes" row — a genuine fixed HEADER (bandH()
// tall, one row) sitting ABOVE the scrollable row viewport, like a sticky
// table header. Real rows are offset by +bandH() (see draw()'s row loop,
// hitTest(), drawDragGhost(), zoomAt()) so row 0 gets its own real slot
// right below the header instead of sharing screen space with it —
// previously the band was painted OVER whatever real row happened to be
// scrolled to the very top, permanently hiding row 0 and eating its clicks
// (hitTest checked the band before ever falling through to real-row math).
// contentH is deliberately UNCHANGED (row-count only; the header is chrome,
// not scrollable content) — only the row<->y mapping shifts, and
// recomputeLayout()'s maxScroll has bandH() folded into it (see there) so
// the LAST row still gets a full slot at max scroll. This comment used to
// call the un-adjusted case "a much smaller, rarer cosmetic" overhang past
// the canvas edge — that undersold it: at scrollTop===maxScroll the last
// row's y-position worked out to EXACTLY view.cssH, i.e. it rendered and
// hit-tested entirely off-canvas — 100% unreachable/unclickable (the root
// commit, permanently) on any repo with more commits than fit on screen,
// not a cosmetic sliver. Fixed by adding bandH() to maxScroll's own formula.
// Uses theme.accent2 for its dot — deliberately NOT one of the
// --l0../LANE_COLORS lane colours, so it never reads as "a real commit".
function drawWorkdirBand(){
  const rowH=layout.rowH, W=view.cssW, dotR=layout.dotR;
  const active=state.selectedRow===-2, hover=state.hoverRow===-2;
  ctx.fillStyle=theme.panel; ctx.fillRect(0,0,W,rowH);
  if(active){ ctx.fillStyle=theme.accent; ctx.globalAlpha=0.20; ctx.fillRect(0,0,W,rowH); ctx.globalAlpha=1;
    ctx.fillStyle=theme.accent; ctx.fillRect(0,0,3,rowH); }
  else if(hover){ ctx.fillStyle=theme.text; ctx.globalAlpha=0.08; ctx.fillRect(0,0,W,rowH); ctx.globalAlpha=1; }
  const y=rowH*0.5, x=laneX(0);
  ctx.beginPath(); ctx.arc(x,y,dotR,0,TAU); ctx.fillStyle=theme.accent2; ctx.fill();
  if(active){ ctx.beginPath(); ctx.arc(x,y,dotR+3.2,0,TAU); ctx.strokeStyle=theme.text; ctx.lineWidth=1.6; ctx.stroke(); }
  else if(hover){ ctx.beginPath(); ctx.arc(x,y,dotR+2.6,0,TAU); ctx.strokeStyle=theme.muted; ctx.lineWidth=1; ctx.stroke(); }
  ctx.textBaseline="middle"; ctx.textAlign="left";
  ctx.font=Math.round(12.5*Math.min(1.25,layout.zoom))+"px "+FONT_UI; ctx.fillStyle=theme.text;
  ctx.fillText("Uncommitted changes",x+dotR+14,y);
  const s=workdirCtrl.status;
  const nConflict=s?s.conflicted:0, nStaged=s?s.staged.length:0, nUnstaged=s?s.unstaged.length:0;
  const badge=nConflict?(nConflict+" conflicted"):(nStaged||nUnstaged)?(nStaged+" staged · "+nUnstaged+" unstaged"):"clean";
  ctx.font=Math.round(10.5*Math.min(1.2,layout.zoom))+"px ui-monospace,monospace";
  ctx.fillStyle=nConflict?theme.danger:theme.muted; ctx.textAlign="right";
  ctx.fillText(badge,W-14,y); ctx.textAlign="left";
  ctx.strokeStyle=theme.border; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,rowH+0.5); ctx.lineTo(W,rowH+0.5); ctx.stroke();
}
// `maxWidth`, when given, caps the WHOLE chip (label + padding) — a label
// that would exceed it is shrunk to fit with a trailing "…", same shrink-one-
// char-at-a-time-and-remeasure approach the subject/author text below
// already use. `maxWidth<=pad*2+8` means there's no usable room at all
// (not even a one-char label plus ellipsis would read as anything but a
// sliver) — draws nothing and returns `x` unchanged rather than a garbled chip.
function drawChip(x,y,label,kind,maxWidth){
  const col=kind==="branch"?LANE_COLORS[0]:kind==="tag"?theme.accent2||"#7FB6A6":theme.accent;
  ctx.font=layout.chipFont;
  const pad=6;
  if(maxWidth!=null&&maxWidth<=pad*2+8) return x;
  let text=label;
  if(maxWidth!=null){
    const textMax=maxWidth-pad*2;
    if(ctx.measureText(text).width>textMax){
      while(text.length>1&&ctx.measureText(text+"…").width>textMax) text=text.slice(0,-1);
      text+="…";
    }
  }
  const w=ctx.measureText(text).width+pad*2, h=Math.round(15*Math.min(1.25,layout.zoom));
  ctx.beginPath(); if(ctx.roundRect)ctx.roundRect(x,y-h/2,w,h,4);else ctx.rect(x,y-h/2,w,h);
  ctx.fillStyle=col; ctx.globalAlpha=kind==="head"?0.92:0.16; ctx.fill(); ctx.globalAlpha=1;
  ctx.lineWidth=1; ctx.strokeStyle=col; ctx.stroke();
  ctx.fillStyle=kind==="head"?theme.bg:col; ctx.textAlign="left"; ctx.fillText(text,x+pad,y+0.5);
  return x+w;
}
function drawDragGhost(){
  const d=state.drag, rowH=layout.rowH, st=state.scrollTop, bh=bandH();
  const sy=d.source*rowH+rowH*0.5-st+bh, sx=laneX(G.commitLane[d.source]);
  ctx.setLineDash([4,4]); ctx.strokeStyle=d.legal?theme.accent:theme.danger; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(d.x,d.y); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.arc(d.x,d.y,layout.dotR+1,0,TAU); ctx.fillStyle=d.legal?theme.accent:theme.danger; ctx.fill();
  if(d.target!=null){const ty=d.target*rowH-st+bh; ctx.strokeStyle=d.legal?theme.accent:theme.danger; ctx.lineWidth=1.4;
    ctx.setLineDash([5,3]); ctx.strokeRect(1,ty,view.cssW-2,rowH); ctx.setLineDash([]);}
}
function scrollbarGeom(H,W){ if(layout.contentH<=H) return null;
  const SB_W=10, thumbH=Math.max(30,H*(H/layout.contentH)), thumbY=state.maxScroll>0?(state.scrollTop/state.maxScroll)*(H-thumbH):0;
  return {x:W-SB_W-2,w:SB_W,thumbY,thumbH,H}; }
function drawScrollbar(st,H,W){ const g=scrollbarGeom(H,W); if(!g)return;
  ctx.fillStyle=theme.muted; ctx.globalAlpha=state.isInteracting?0.5:0.26;
  ctx.beginPath(); if(ctx.roundRect)ctx.roundRect(g.x,g.thumbY+2,g.w,g.thumbH-4,5);else ctx.rect(g.x,g.thumbY+2,g.w,g.thumbH-4);
  ctx.fill(); ctx.globalAlpha=1; }
// Horizontal counterpart to scrollbarGeom/drawScrollbar above — purely a
// visual "you can pan sideways, and here's roughly where you are" cue (see
// state.panX's own doc comment for why panning exists at all); dragging it
// directly isn't wired up since the empty-canvas click-drag gesture
// (pointermove's `down.moved` branch) already pans horizontally exactly like
// it already scrolled vertically, one drag covers both axes at once.
function hScrollbarGeom(H,W){ if(state.maxPanX<=0) return null;
  const totalW=W+state.maxPanX, SB_H=10, thumbW=Math.max(30,W*(W/totalW)), thumbX=(state.panX/state.maxPanX)*(W-thumbW);
  return {y:H-SB_H-2,h:SB_H,thumbX,thumbW,W}; }
function drawHScrollbar(H,W){ const g=hScrollbarGeom(H,W); if(!g)return;
  ctx.fillStyle=theme.muted; ctx.globalAlpha=state.isInteracting?0.5:0.26;
  ctx.beginPath(); if(ctx.roundRect)ctx.roundRect(g.thumbX+2,g.y,g.thumbW-4,g.h,5);else ctx.rect(g.thumbX+2,g.y,g.thumbW-4,g.h);
  ctx.fill(); ctx.globalAlpha=1; }

/* ============================================================
   5) HIT TEST — pure arithmetic, works at any commit count
   ============================================================ */
// True when the pinned "Uncommitted changes" band should be drawn/hittable:
// a real repo is open (Tauri), or we're in browser design mode (where a repo
// is never "open" but the synthetic graph stands in for one throughout).
function workdirAvailable(){ return IN_TAURI ? !!CUR_REPO : true; }
// Height of the pinned band THIS frame — one full row tall (it scales with
// zoom exactly like every other row; drawWorkdirBand() always draws it
// layout.rowH tall) when it's actually being shown, else 0. Every place that
// converts a row index to an on-screen y, or a screen y back to a row
// index, must add/subtract this — real rows get a genuine slot BELOW the
// fixed header instead of sharing one with it. Exported via bridge.ts so
// the ⌘K and bisect-drawer "scroll a row into view" call sites (which live
// outside this file) can stay consistent with it too.
function bandH(){ return workdirAvailable()?layout.rowH:0; }
function hitTest(mx,my){
  const rowH=layout.rowH, bh=bandH();
  // The pinned band lives in FIXED screen space (independent of
  // state.scrollTop, same trick the ribbon uses) at the very top of the
  // viewport — check it before falling through to the real-row math below.
  // onDot:false so a pointerdown here is never mistaken for the start of a
  // cherry-pick/merge drag (see the pointermove handler).
  if(bh>0&&my>=0&&my<bh) return {row:-2,lane:0,onDot:false,x:laneX(0),y:bh*0.5};
  // Real rows start at screen y=bh (the header's own height) — subtract it
  // BEFORE dividing by rowH, or every row reads one slot too high, and row 0
  // becomes unreachable/mis-hit exactly like the bug this fixes.
  const row=Math.floor((state.scrollTop+(my-bh))/rowH);
  if(row<0||row>=G.N) return null;
  const lane=G.commitLane[row], x=laneX(lane), y=row*rowH+rowH*0.5-state.scrollTop+bh;
  const dx=mx-x, dy=my-y, hitR=layout.dotR+6;
  return {row,lane,onDot:(dx*dx+dy*dy)<=hitR*hitR,x,y};
}
function rel(e){const r=cv.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}

cv.addEventListener("wheel",(e)=>{
  if(e.ctrlKey||e.metaKey){e.preventDefault();zoomAt(rel(e).y,-e.deltaY);return;}
  // Horizontal pan (see state.panX's own doc comment) — a real trackpad's
  // two-finger horizontal swipe reports as e.deltaX directly; a mouse wheel
  // (or a trackpad that doesn't) reports the traditional "hold Shift to
  // scroll sideways" gesture as e.shiftKey with the magnitude still on
  // e.deltaY, so that's read as the pan delta instead whenever deltaX itself
  // is ~0. Whichever axis actually has more magnitude wins, so a slightly
  // diagonal vertical scroll never accidentally pans too.
  const dx=(e.shiftKey&&Math.abs(e.deltaX)<1)?e.deltaY:e.deltaX;
  if(Math.abs(dx)>Math.abs(e.deltaY)){e.preventDefault();state.panTarget=clampPan(state.panTarget+dx);dirty=true;return;}
  e.preventDefault();state.scrollTarget=clampScroll(state.scrollTarget+e.deltaY);dirty=true;
},{passive:false});
function zoomAt(cy,dir){
  // Anchor on the content point under the cursor — same math as before, just
  // shifted by the header's height first. bandH() is read again AFTER
  // recomputeLayout() since the header scales with zoom exactly like every
  // other row (see bandH()'s own comment).
  const bh0=bandH(), contentY=state.scrollTop+cy-bh0, frac=contentY/layout.rowH;
  layout.zoom=Math.max(0.55,Math.min(2.4,layout.zoom*Math.exp(dir*0.0016)));
  recomputeLayout();
  state.scrollTop=state.scrollTarget=clampScroll(frac*layout.rowH-cy+bandH());
  positionTicks();
}

let down=null, sbDrag=null;
cv.addEventListener("pointerdown",(e)=>{
  // Primary (left) button only — a right-click (button 2, or a middle-click)
  // must never arm `down`/a potential drag. Without this, right-clicking
  // directly on a commit's dot would arm a drag exactly like a left-click,
  // and any tiny mouse movement before the button lifts would turn it into
  // a live cherry-pick/merge gesture racing the "contextmenu" listener below
  // — two actions from one right-click. Returning here before anything else
  // runs (focus/capture/hitTest/`down=`) keeps this purely additive: it only
  // excludes non-primary-button presses, every left-click path (row select,
  // scrollbar drag, cherry-pick/merge drag, panning) is untouched.
  if(e.button!==0) return;
  cv.focus(); cv.setPointerCapture(e.pointerId); const p=rel(e), g=scrollbarGeom(view.cssH,view.cssW);
  state.pointerActive=true;
  if(g&&p.x>=g.x-4){sbDrag={grab:p.y-g.thumbY,thumbH:g.thumbH};return;}
  down={x0:p.x,y0:p.y,st0:state.scrollTarget,panX0:state.panTarget,hit:hitTest(p.x,p.y),moved:false};
  // Fire the real-ancestor-set fetch as early as possible (see
  // primeDragAncestors' own doc comment) — pointerdown, not the first
  // pointermove past the drag threshold, so it has the most possible time to
  // land before legalPick/legalMerge's first per-frame check actually needs
  // it. Harmless if this press never turns into a real drag (a plain click).
  if(down.hit&&down.hit.onDot) primeDragAncestors(down.hit.row);
});
cv.addEventListener("pointermove",(e)=>{
  const p=rel(e);
  if(sbDrag){const H=view.cssH, frac=(p.y-sbDrag.grab)/(H-sbDrag.thumbH);
    state.scrollTarget=state.scrollTop=clampScroll(Math.max(0,Math.min(1,frac))*state.maxScroll);dirty=true;return;}
  if(down){
    const dx=p.x-down.x0, dy=p.y-down.y0; if(!down.moved&&Math.hypot(dx,dy)>4)down.moved=true;
    if(down.hit&&down.hit.onDot){ const t=hitTest(p.x,p.y), tRow=t?t.row:null;
      // Hold Shift while dragging to MERGE the source commit/branch tip into
      // HEAD instead of cherry-picking it — same gesture, one modifier key
      // distinguishes the two ops (mirrors e.g. Finder's option-drag-to-copy).
      // Read live every move so toggling Shift mid-drag updates the ghost.
      const isMerge=!!e.shiftKey;
      const legal=isMerge?legalMerge(down.hit.row,tRow):legalPick(down.hit.row,tRow);
      state.drag={source:down.hit.row,x:p.x,y:p.y,target:tRow,legal:legal.ok,op:isMerge?"merge":"pick"};
      updateGhost(down.hit.row,tRow,legal,isMerge); dirty=true;
    } else if(down.moved){ state.scrollTarget=clampScroll(down.st0-dy); state.panTarget=clampPan(down.panX0-dx); dirty=true; }
    return;
  }
  const h=hitTest(p.x,p.y), nr=h?h.row:-1; if(nr!==state.hoverRow){state.hoverRow=nr;dirty=true;}
  cv.style.cursor=h&&h.onDot?"grab":"default";
});
function endPointer(e){
  const p=rel(e);
  if(sbDrag){sbDrag=null;state.pointerActive=false;return;}
  if(down){
    if(!down.moved&&down.hit){ if(down.hit.row===-2) selectWorkdir(); else select(down.hit.row); }
    else if(!down.moved&&!down.hit) deselect();
    else if(state.drag){
      const isMerge=state.drag.op==="merge", t=hitTest(p.x,p.y), tRow=t?t.row:null;
      const legal=isMerge?legalMerge(state.drag.source,tRow):legalPick(state.drag.source,tRow);
      if(tRow!=null&&legal.ok){
        // Keep the ghost on screen (relabeled "pending") for the duration of
        // the pick/merge instead of tearing it down on this same tick — it
        // used to vanish the instant the drop was accepted, leaving nothing
        // visible for however long the actual IPC call + resolver.startPick/
        // startMerge took to settle (a real conflict modal doesn't appear
        // until then either).
        if(ghostEl){ ghostEl.classList.add("pending"); $(".reason",ghostEl).textContent=isMerge?"Merging…":"Picking…"; }
        const op=isMerge?mergeCommit(state.drag.source,tRow):cherryPick(state.drag.source,tRow);
        op.finally(removeGhost);
        state.drag=null; down=null; state.pointerActive=false; dirty=true;
        return;
      }
    }
  }
  removeGhost(); state.drag=null; down=null; state.pointerActive=false; dirty=true;
}
cv.addEventListener("pointerup",endPointer); cv.addEventListener("pointercancel",endPointer);
// Commit-row context menu (src/islands/commitmenu) — the canvas's first-ever
// "contextmenu" listener (there was previously NO per-commit-row menu at all;
// see that island's own header). preventDefault so the native OS/browser menu
// never shows; ignore anywhere that isn't a real commit row (row<0 — either
// empty canvas space, hitTest()'s null, or the pinned "Uncommitted changes"
// band's row:-2 sentinel — none of cherry-pick/merge/revert/branch/tag make
// sense there). select(row) first so the Detail panel reflects the
// right-clicked commit exactly like a left-click would — consistent visual
// feedback before the menu even opens. sha resolution mirrors cherryPick()/
// mergeCommit()'s own line below (real BACKEND row sha, else hhex(row) in
// design mode).
cv.addEventListener("contextmenu",(e)=>{
  e.preventDefault();
  const p=rel(e), hit=hitTest(p.x,p.y);
  if(!hit||hit.row<0) return;
  const row=hit.row;
  select(row);
  const sha=(BACKEND&&BACKEND.rows[row])?BACKEND.rows[row].sha:hhex(row);
  commitMenuCtrl.openAt(CUR_REPO, sha, msgOf(row), !!(G&&G.isMerge&&G.isMerge[row]), e.clientX, e.clientY);
});
cv.addEventListener("keydown",(e)=>{
  const rowH=layout.rowH;
  if(e.key==="ArrowDown")state.scrollTarget=clampScroll(state.scrollTarget+rowH);
  else if(e.key==="ArrowUp")state.scrollTarget=clampScroll(state.scrollTarget-rowH);
  else if(e.key==="PageDown")state.scrollTarget=clampScroll(state.scrollTarget+view.cssH*0.9);
  else if(e.key==="PageUp")state.scrollTarget=clampScroll(state.scrollTarget-view.cssH*0.9);
  else if(e.key==="Home")state.scrollTarget=0; else if(e.key==="End")state.scrollTarget=state.maxScroll;
  else if(e.key==="+"||e.key==="=")zoomAt(view.cssH/2,120); else if(e.key==="-")zoomAt(view.cssH/2,-120);
  else return; e.preventDefault(); dirty=true;
});

// Real ancestor set for the currently-dragged commit — see isAncestorTarget's
// own doc comment for why this exists (row-index alone can't tell "ancestor"
// from "just happens to sit lower on screen" across branches) and
// primeDragAncestors' for how/when it's populated. `shas:null` means "no real
// answer yet for this source row" (fetch still in flight, failed, or — in
// design-mode preview — never coming at all, no real backend to ask).
let dragAncestors={srcRow:null,shas:null};
// Called ONCE per drag gesture, at pointerdown (see the "pointerdown"
// listener below) — NOT per-hover-frame, since legalPick/legalMerge run
// every frame for every visible row while a drag is active (see draw()'s own
// call site) and a live drag can't afford an IPC round trip that often.
// Resets `shas` to null immediately so any legality check before the fetch
// lands correctly falls back to the approximation for the (possibly new)
// source row, rather than briefly reusing a previous drag's stale answer.
function primeDragAncestors(srcRow){
  dragAncestors={srcRow,shas:null};
  if(!IN_TAURI||!CUR_REPO) return; // design-mode preview: no real backend to ask, stays on the approximation forever
  const srcSha=(BACKEND&&BACKEND.rows[srcRow])?BACKEND.rows[srcRow].sha:hhex(srcRow);
  commands.ancestorsOf(CUR_REPO,srcSha).then(res=>{
    if(dragAncestors.srcRow!==srcRow) return; // superseded by a newer drag before this landed
    if(res.status==="ok") dragAncestors={srcRow,shas:new Set(res.data)};
  }).catch(()=>{}); // best-effort — a failed fetch just keeps the approximation, same as "not loaded yet"
}
// Is `tgt` an ancestor of `src` (illegal drop target for both cherry-pick and
// merge)? Uses the real, precomputed set from primeDragAncestors when it's
// ready for this exact source row; otherwise falls back to the OLD
// approximation (a target strictly BELOW the source — larger row index —
// reads as an ancestor). That approximation is exactly right on a single
// unbranched line, but wrong in general: row order interleaves EVERY branch
// by time/topology, so a commit on a totally unrelated branch can easily
// sit at a larger row index than the source without being its ancestor at
// all — silently rejecting one of the most common real cherry-pick/merge
// uses (taking a commit onto a different branch) whenever the target
// happened to land lower on screen. The fallback only covers the brief
// window before the real set arrives (or design-mode preview, forever).
function isAncestorTarget(src,tgt){
  if(dragAncestors.srcRow===src&&dragAncestors.shas){
    const tgtSha=(BACKEND&&BACKEND.rows[tgt])?BACKEND.rows[tgt].sha:hhex(tgt);
    return dragAncestors.shas.has(tgtSha);
  }
  return tgt>src;
}
// `resolver.busy` check comes first in both: without it, a second drag could
// start (and show a fully "legal" green ghost, and animate a drop) while a
// PRIOR pick/merge was still resolving — resolver.startPick/startMerge would
// then silently no-op via their own re-entrancy guard, dropping the second
// gesture on the floor with zero visible feedback. Marking it illegal here
// instead surfaces a real reason in the ghost tooltip.
function legalPick(src,tgt){
  if(resolver.busy) return {ok:false,why:"a pick/merge is already in progress"};
  if(tgt===-2) return {ok:false,why:"drop on a commit, not the working tree"};
  if(tgt==null) return {ok:false,why:"drop on a commit"};
  if(tgt===src) return {ok:false,why:"onto itself"};
  if(G&&G.isMerge&&G.isMerge[src]) return {ok:false,why:"can't cherry-pick a merge"};
  if(isAncestorTarget(src,tgt)) return {ok:false,why:"target is an ancestor"};
  return {ok:true,why:"→ "+hhex(tgt)};
}
/* merge legality: mirrors legalPick's spirit (dropping onto an ancestor or
   onto itself is illegal) — but unlike cherry-pick, merging a merge commit's
   tip is perfectly legal, so there is no isMerge(src) rejection here. */
function legalMerge(src,tgt){
  if(resolver.busy) return {ok:false,why:"a pick/merge is already in progress"};
  if(tgt===-2) return {ok:false,why:"drop on a commit, not the working tree"};
  if(tgt==null) return {ok:false,why:"drop on a commit"};
  if(tgt===src) return {ok:false,why:"onto itself"};
  if(isAncestorTarget(src,tgt)) return {ok:false,why:"target is an ancestor"};
  return {ok:true,why:"⇄ "+hhex(tgt)};
}
let ghostEl=null;
function updateGhost(src,tgt,legal,isMerge){
  if(!ghostEl){ghostEl=document.createElement("div");ghostEl.className="cp-ghost";
    ghostEl.innerHTML='<span class="g-dot"></span><span class="spinner"></span><span class="lbl"></span><span class="reason"></span>';document.body.appendChild(ghostEl);}
  const d=state.drag; ghostEl.style.left=(cv.getBoundingClientRect().left+d.x+12)+"px";
  ghostEl.style.top=(cv.getBoundingClientRect().top+d.y+12)+"px";
  ghostEl.classList.toggle("illegal",!legal.ok);
  ghostEl.classList.toggle("merge",!!isMerge);
  $(".lbl",ghostEl).textContent=(isMerge?"merge ":"pick ")+hhex(src);
  $(".reason",ghostEl).textContent=legal.ok?legal.why:"✕ "+legal.why;
}
function removeGhost(){ if(ghostEl){ghostEl.remove();ghostEl=null;} }
async function cherryPick(src,dst){
  const srcSha=(BACKEND&&BACKEND.rows[src])?BACKEND.rows[src].sha:hhex(src);
  if(!IN_TAURI){ resolver.openDemo(srcSha); return; }   // ---- design-mode demo ----
  const recordOrigin=loadSettings().cherryPickRecordOriginDefault;
  await resolver.startPick(CUR_REPO, srcSha, recordOrigin);  // ---- real pick onto HEAD (Svelte island) ----
}
async function mergeCommit(src,dst){
  const srcSha=(BACKEND&&BACKEND.rows[src])?BACKEND.rows[src].sha:hhex(src);
  if(!IN_TAURI){ resolver.openDemo(srcSha,"merge"); return; }   // ---- design-mode demo ----
  await resolver.startMerge(CUR_REPO, srcSha);  // ---- real merge into HEAD (Svelte island) ----
}


/* ============================================================
   6) SAFETY MANAGER (engine) + TAMA (its face). Snapshots, op-log
      and undo run in EVERY mascot mode; Tama only decides whether
      she wakes and what one sentence she says.
   ============================================================ */
// Ref -> its display suffix, e.g. "refs/gitgui/backup/1783884395-123456789-2"
// -> "1783884395-123456789-2" — mirrors src-tauri's own `short_backup()`
// (git_bisect.rs/git_merge.rs/…), used everywhere else a backup ref is shown
// to the user. A blind `.slice(-8)` (the old code here) lands mid-number on
// this ref shape and prints a meaningless fragment like "28000-12".
function shortBackup(ref){ const i=ref.lastIndexOf("/"); return i<0?ref:ref.slice(i+1); }
const Safety={ count:214, lastAt:performance.now()-2*60*1000, snaps:[], pad(n){return String(n).padStart(2,"0");},
  // Single point that writes #undoCount AND toggles #undoBtn's disabled
  // state — there's genuinely nothing for Undo to do at zero snapshots
  // (globalUndo mirrors this same zero-check for the ⌘Z shortcut, which
  // bypasses a disabled button entirely).
  updateBadge(){ const n=IN_TAURI?this.snaps.length:this.count; $("#undoCount").textContent=n; $("#undoBtn").disabled=n===0; },
  seal(){ if(IN_TAURI){ const s=this.snaps[0]; return { ref: s?s.ref:"refs/gitgui/backup/-", hash: s?s.sha:"" }; }
    this.count++; this.lastAt=performance.now();
    const d=new Date();
    const ts=d.getFullYear()+"-"+this.pad(d.getMonth()+1)+"-"+this.pad(d.getDate())+"T"+this.pad(d.getHours())+"-"+this.pad(d.getMinutes())+"-"+this.pad(d.getSeconds());
    this.updateBadge();
    return {ref:"refs/gitgui/backup/"+ts, hash:hhex(this.count*7+3)}; },
  async refresh(){ if(!IN_TAURI||!CUR_REPO) return;
    try{ const s=await tinvoke("list_snapshots",{path:CUR_REPO});
      this.snaps=Array.isArray(s)?s.slice():[];
      this.updateBadge();
      Tama._tele(); positionTicks(); sidebarCtrl.setSnapshots(this.snaps);
    }catch(e){ console.error("list_snapshots",e); } },
  teleCount(){ return IN_TAURI ? this.snaps.length : this.count; },
  teleAgo(){ if(IN_TAURI){ return this.snaps.length ? relTime(this.snaps[0].ts).replace(" ago","") : "—"; }
    const m=Math.max(0,Math.round((performance.now()-this.lastAt)/60000)); return m<1?"just now":m+"m"; } };

class TamaMascot{
  static STATES={idle:{sticky:false},sleep:{sticky:false},hint:{sticky:false,dwell:3200},thinking:{sticky:true},warn:{sticky:true},danger:{sticky:true},celebrate:{sticky:false,dwell:3600},rescue:{sticky:true},
    // confused: a real operation FAILURE (see warn() below — distinct from
    // "warn", which stays reserved for a pre-mutation CAUTION via
    // mutation.caution; both used the same pose before this split).
    confused:{sticky:true},
    // curious: a fresh repo just finished loading — see openRepo()'s success
    // path. Non-sticky/dwell like "hint" (which it replaces there): settles
    // back to idle on its own once the toast's dwell elapses.
    curious:{sticky:false,dwell:3200},
    // syncing: fetch/pull/push specifically — see doFetch/doPull/doPush,
    // which used the generic "thinking" pose before this split (still used
    // by every OTHER long op: bisect sweeps, filter-repo, …).
    syncing:{sticky:true},
    // greeting: no repo open (cold boot or Close Repository) — see
    // bootEmpty(). Non-sticky/dwell like "celebrate": settles back to idle
    // (which just sits there, since idle IS the resting look while empty).
    greeting:{sticky:false,dwell:3600}};
  // Maps each FSM state to one of TAMA_IMG's 8 model-rendered poses — see
  // main.ts's own TAMA_IMG comment + the redesign's pose-mapping table for
  // why each pairing was chosen (fewer poses than states; several states
  // intentionally share one).
  static POSE=TAMA_SPRITE_POSES;
  constructor(el){this.nook=el.nook;this.sprite=el.sprite;this.spriteWrap=el.spriteWrap;this.line=el.line;this.tele=el.tele;
    this.sticky=null;this.toastT=null;this.dwellT=null;this.reduced=matchMedia("(prefers-reduced-motion:reduce)").matches;
    this.actor=createTamaPresentation({host:this.spriteWrap,modelMount:el.modelMount,sprite:this.sprite,images:TAMA_IMG,reducedMotion:this.reduced});
    this.set("idle");void this.actor.load();this._teleLoop();}
  // Only touches the portrait's `src` when the resolved pose actually
  // changed (several states share one pose — see POSE above) — a real
  // "pop" (shrink+fade out via .swap, swap src, overshoot back in via
  // .swap-in — see index.html's own spriteSwapOut/spriteSwapIn keyframes),
  // skipped entirely under reduced-motion (immediate swap, no animation).
  set(s){clearTimeout(this.dwellT);const cfg=TamaMascot.STATES[s]||TamaMascot.STATES.idle;
    if(!TamaMascot.STATES[s])s="idle";
    this.actor.setState(s);
    // Sound plays on a real FSM-STATE change, not a pose change (several
    // states above intentionally share one pose) — captured before
    // overwriting dataset.state so re-entering the same state (e.g. two
    // "warn" calls in a row) doesn't replay the chime.
    const prevState=this.nook.dataset.state;
    this.nook.dataset.state=s;
    if(prevState!==s){const kind=STATE_SOUND[s];if(kind)playTamaSound(kind);}
    if(cfg.sticky)this.sticky=s;
    if(!cfg.sticky&&cfg.dwell)this.dwellT=setTimeout(()=>this.set(this.sticky||"idle"),cfg.dwell);
    if(!cfg.sticky&&!cfg.dwell)this.sticky=null;}
  // ms is a FLOOR, not the actual dwell — every caller below passes a fixed
  // guess (3200 default, up to 6000 for the danger copy), but the message
  // text itself was never a factor, so a long message could get yanked away
  // before it's even read. 50ms/char (~20 chars/sec) covers that on top of
  // whatever floor the caller asked for, and leaves short toasts unchanged.
  say(t,ms=3200){if(!t){this.line.classList.remove("show");return;}this.line.textContent=t;this.line.classList.add("show");
    const dwell=Math.max(ms,1200+t.length*50);
    clearTimeout(this.toastT);this.toastT=setTimeout(()=>this.line.classList.remove("show"),dwell);}
  // "confused", not "warn" — this is a real operation FAILURE (every
  // call site across the app), distinct from mutation.caution's own
  // pre-mutation "warn" pose (which still calls set("warn") directly, not
  // this method).
  warn(t,ms=5000){this.set("confused");this.say(t,ms);}
  // A quick acknowledgement bounce (renamed from wag() — there's no tail on
  // a portrait) for a routine "nothing to do" moment; same remove/reflow/
  // add restart trick the old tail-wag used, so retriggering it before the
  // previous one finishes still replays from the start.
  nod(){this.actor.playGesture("nod");}
  setInteracting(on){this.nook.classList.toggle("is-interacting",on);this.actor.setPaused(on);}
  event(name,p={}){
    switch(name){
      case "fetch.upToDate": case "checkout.clean": this.nod(); return null;
      case "commit.created": Safety.seal(); this._tele(); return null;
      case "snapshot.surfaced":{const b=Safety.seal();this._tele();this.set("hint");this.say("Backup "+shortBackup(b.ref)+" pinned — you're covered.");return b;}
      case "op.long": this.set("thinking"); this.say(""); this._teleText((p.label||"working")+" · 0 / "+(p.total||10000)); return null;
      case "op.progress": this._teleText((p.label||"working")+" · "+p.done+" / "+p.total); return null;
      case "op.done": this.set(this.sticky&&this.sticky!=="thinking"?this.sticky:"idle"); this._tele(); return null;
      case "mutation.caution":{const b=Safety.seal();this._tele();this.set("warn");const cnt=p.count?p.count+" commit"+(p.count===1?"":"s"):"a few commits";this.say("Heads up — this rewrites "+cnt+". Backup "+shortBackup(b.ref)+" saved first.",4200);return b;}
      case "mutation.destructive":{const b=Safety.seal();this._tele();this.set("danger");this.say((p.label||"This")+" can't be undone. Backup "+shortBackup(b.ref)+" is pinned — type the ref name to go on.",6000);return b;}
      case "mutation.cancel": this.sticky=null; this.set("idle"); this.say(""); return null;
      case "undo.performed":{const s=Safety.seal();this._tele();this.sticky=null;this.set("celebrate");this.say("Rewound to "+(p.hash||"a1b2c3d")+" — nothing lost, I sealed "+shortBackup(s.ref)+" first. ♪",4200);return s;}
      case "rescue.detached": this.set("rescue"); this.say("Detached HEAD — I've got you. One tap puts you back on "+(p.branch||"main")+".",6000); return null;
      case "rescue.resolved": this.sticky=null; this.set("celebrate"); this.say("You're back on "+(p.branch||"main")+". Safe and sound.",3600); return null;
      case "idle": this.sticky=null; this.set("idle"); this.say(""); return null;
      default: return null;
    }
  }
  _teleText(t){this.tele.textContent=t;}
  _tele(){this.tele.textContent="snapshots "+Safety.teleCount()+" · last "+Safety.teleAgo();}
  _teleLoop(){this._tele();setInterval(()=>{if(this.nook.dataset.state!=="thinking")this._tele();},20000);}
}
const Tama=new TamaMascot({nook:$("#nook"),sprite:$("#sprite"),spriteWrap:$("#spriteWrap"),modelMount:$("#tamaModel"),line:$("#toastLine"),tele:$("#telemetry")});

/* The nook cat subtly leans toward your cursor, and naps when you go idle.
   The sprite fallback cannot move its own pupils, so this leans/tilts the
   whole portrait a few px+deg instead, via
   .sprite-wrap's own transform (kept separate from .sprite's own
   continuous breathe/nod animation — see index.html's own comment on why
   those two elements are split). */
Tama.lastMove=performance.now();
const _gazeOn=new Set(["idle","hint","warn","rescue","thinking","confused","curious","syncing"]);
function gaze(mx,my){
  const st=$("#nook").dataset.state;
  if(Tama.reduced||!_gazeOn.has(st)){ Tama.actor.clearPointer(); return; }
  Tama.actor.setPointer(mx,my);
}
document.addEventListener("mousemove",e=>{
  Tama.lastMove=performance.now();
  if($("#nook").dataset.state==="sleep") Tama.set("idle");
  gaze(e.clientX,e.clientY);
},{passive:true});
setInterval(()=>{ const n=$("#nook"); if(n&&n.dataset.state==="idle"&&performance.now()-Tama.lastMove>13000) Tama.set("sleep"); },2500);

// A brief automatic "glance" every ~8-14s, independent of real cursor
// movement — without this, a STILL mouse means the corner sits frozen on
// nothing but the idle breathe loop, which reads as static even with a
// live cursor-tilt feature nobody happens to be triggering right now.
// Skipped if the cursor moved recently (real gaze already covers that
// case) or under reduced-motion. setTimeout-chained (not setInterval) so
// each gap is independently randomized, not a fixed repeating period.
function scheduleGlance(){
  setTimeout(()=>{
    const wrap=$("#spriteWrap"), n=$("#nook");
    if(wrap&&n&&!Tama.reduced&&_gazeOn.has(n.dataset.state)&&performance.now()-Tama.lastMove>4000){
      Tama.actor.playGesture("glance");
    }
    scheduleGlance();
  },8000+Math.random()*6000);
}
scheduleGlance();
window.addEventListener("beforeunload",()=>Tama.actor.destroy(),{once:true});

// Hidden Easter egg: click the portrait itself 7 times within 2.5s to open
// Tama Gallery (src/islands/tamagallery) — every pose in one grid, click a
// card to "play" it live right here. Deliberately undiscoverable —
// scoped to just the portrait (not the whole nook, which would fire on
// stray clicks on the toast/telemetry text too), no cursor hint, no menu/
// ⌘K entry anywhere else. Resets on its own after 2.5s of no further
// clicks, so an idle stray double-click can't silently half-arm it.
(function () {
  let n = 0,
    t = null;
  $("#spriteWrap").addEventListener("click", () => {
    n++;
    clearTimeout(t);
    t = setTimeout(() => {
      n = 0;
    }, 2500);
    if (n >= 7) {
      n = 0;
      tamaGalleryCtrl.show();
    }
  });
})();

/* ============================================================
   7) DETAIL PANEL (author/committer split, gpg, diffstat, tree, diff)
   ============================================================ */
function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}
const AUTHORS=[{n:"Jiucheng Zang",e:"jiucheng@gitcat.dev"},{n:"Tama",e:"tama@gitcat.dev"},{n:"Rin S.",e:"rin@catnip.io"},{n:"A. Turing",e:"alan@enigma.dev"},{n:"Mao",e:"mao@nyan.cat"}];
// The detail panel itself is now a Svelte island (src/islands/detail) — see
// detailCtrl.select()/commitMeta(). GRAMMARS/highlight stay here: they're
// shared with Resolver.svelte's 3-way diff view via bridge.highlight.
// row is a real 0-indexed row; -2 is the pinned "Uncommitted changes" row's
// OWN sentinel (see selectWorkdir below) and never reaches here directly —
// hitTest()/endPointer route a -2 hit to selectWorkdir() instead. Closes the
// working-tree panel (if it was open) so the two selections stay mutually
// exclusive in the shared #detail slot.
function select(row){ state.selectedRow=row; workdirCtrl.deselect(); detailCtrl.select(row); dirty=true; }
// The pinned row: lives in fixed screen space above the scrolling graph
// (drawWorkdirBand()/hitTest()), consumes no slot in G.N, and swaps #detail
// to the Workdir Svelte island instead of a real commit's detail. -2 is
// distinct from -1 (nothing selected) and any real row (>=0).
function selectWorkdir(){ state.selectedRow=-2; workdirCtrl.select(CUR_REPO); dirty=true; }
// "Uncommitted Changes" (Tools menu / ⌘K, see menu.rs/cmdk.svelte.ts) — a fast
// jump to the pinned row above, equivalent to clicking it directly, PLUS a
// scroll reset: the band is always visible regardless of scroll position, but
// resetting scrollTarget re-orients a user who was deep in history rather than
// leaving the rest of the canvas showing unrelated old commits. cv.focus() is
// best-effort, same convention as cmdk's own jump().
function goToUncommitted(){ selectWorkdir(); state.scrollTarget=0; try{cv.focus()}catch(_){} }
// Clicking empty canvas space (no commit dot under the pointer) while a
// commit OR the pinned row is selected — brings back Tama's hero card
// instead of leaving the detail panel stuck on the last selection forever.
function deselect(){ if(state.selectedRow===-1) return; state.selectedRow=-1; workdirCtrl.deselect(); detailCtrl.deselect(); dirty=true; }
const GRAMMARS={
  ts:[["com",/\/\/[^\n]*|\/\*[\s\S]*?\*\//y],["str",/`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y],
     ["key",/\b(?:const|let|var|function|return|if|else|for|while|new|class|extends|implements|interface|type|import|export|from|await|async|of|in|typeof|instanceof|null|undefined|true|false|this|void|public|private|readonly|enum)\b/y],
     ["fn",/[A-Za-z_$][\w$]*(?=\s*\()/y],["num",/\b0x[\da-fA-F]+|\b\d+(?:\.\d+)?\b/y],["punc",/[{}()\[\];,.:?=<>+\-*/%&|!~]+/y]],
  generic:[["com",/#[^\n]*|\/\/[^\n]*/y],["str",/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y],["num",/\b\d+(?:\.\d+)?\b/y],["punc",/[{}()\[\];,.:=<>+\-*/%]+/y]],
};
function highlight(src,lang){const rules=GRAMMARS[lang]||GRAMMARS.generic;let i=0,out="";
  outer:while(i<src.length){for(const [type,re] of rules){re.lastIndex=i;const m=re.exec(src);
    if(m&&m.index===i){out+=`<span class="tok-${type}">${esc(m[0])}</span>`;i+=m[0].length||1;continue outer;}}
    out+=esc(src[i]);i++;} return out;}

/* ============================================================
   8) BISECT — drawer chrome is now a Svelte island (src/islands/bisectdrawer).
      draw() above reads bisectDrawerCtrl.active()/.skips/.cur directly each
      frame to recolor the candidate range + current-test dot on the canvas.
   ============================================================ */


/* ============================================================
   9) TOP BAR + RIBBON + MODALS wiring
   ============================================================ */

// sidebar/detail drag-to-resize — live-updates the .app grid's --sidebar-w/
// --detail-w custom properties (see the .app rule); the canvas's own
// ResizeObserver (below, on canvasWrap) already reacts to the resulting
// width change, so no separate resize() call is needed here.
//
// Collapse (added on top of the original resize-only behavior): dragging
// PAST `min` no longer clamps flat — the panel keeps shrinking, live, down
// to `railW`, so the user gets continuous visual feedback that they're now
// collapsing it rather than just hitting a wall. Releasing decides the
// RESTING state: past the halfway point between `min` and `railW`, it
// snaps fully collapsed (panel content hidden via the `collapsed` class —
// see index.html's own `.sidebar.collapsed`/`.detail.collapsed` rules);
// short of halfway, it snaps back out to `min` instead of resting at some
// in-between width nothing else in this app ever produces. Once collapsed,
// the handle itself — now stretched by CSS to fill the whole (railW-wide)
// panel and showing a chevron — IS the reopen affordance: a plain click
// (tracked via `dragged`, same "did the pointer actually move" signal
// index.html's own hint text promises) restores `lastExpandedW`, the most
// recent width the panel actually rested at before collapsing.
function wireResizeHandle(handle,cssVar,min,max,fromRight,railW){
  if(!handle) return;
  const root=document.documentElement;
  let startX=0,startW=0,dragged=false,collapsed=false;
  let lastExpandedW=parseFloat(getComputedStyle(root).getPropertyValue(cssVar))||min;
  const collapseAt=(min+railW)/2;
  function setCollapsed(v){
    collapsed=v;
    handle.parentElement.classList.toggle("collapsed",v);
    handle.title=v?"Click to expand":"Drag to resize — drag past the edge to collapse";
  }
  function onMove(e){
    const dx=e.clientX-startX;
    if(Math.abs(dx)>3) dragged=true;
    const raw=fromRight?startW-dx:startW+dx;
    const clamped=Math.max(railW,Math.min(max,raw));
    root.style.setProperty(cssVar, clamped+"px");
    setCollapsed(clamped<min);
  }
  function onUp(){
    document.removeEventListener("pointermove",onMove);
    document.removeEventListener("pointerup",onUp);
    handle.classList.remove("active"); root.classList.remove("resizing");
    if(!dragged){
      // A plain click, no drag at all: only meaningful while collapsed
      // (reopen); a click on an already-expanded handle is a no-op, same as
      // today.
      if(collapsed){ setCollapsed(false); root.style.setProperty(cssVar, lastExpandedW+"px"); }
      return;
    }
    const cur=parseFloat(getComputedStyle(root).getPropertyValue(cssVar));
    if(cur<min){
      if(cur<=collapseAt){ setCollapsed(true); root.style.setProperty(cssVar, railW+"px"); }
      else { setCollapsed(false); root.style.setProperty(cssVar, min+"px"); lastExpandedW=min; }
    } else {
      lastExpandedW=cur;
    }
  }
  function beginDrag(startClientX){
    startX=startClientX; dragged=false;
    startW=parseFloat(getComputedStyle(root).getPropertyValue(cssVar))||handle.parentElement.getBoundingClientRect().width;
    handle.classList.add("active"); root.classList.add("resizing");
    document.addEventListener("pointermove",onMove);
    document.addEventListener("pointerup",onUp);
  }
  handle.addEventListener("pointerdown",e=>{ e.preventDefault(); beginDrag(e.clientX); });
  // Keyboard equivalent of the reopen-by-click path above — the handle is a
  // real (tabindex="0" role="button") focusable control (see index.html),
  // not just a drag target, so Enter/Space should work exactly like a plain
  // click: reopen if collapsed, no-op otherwise. Never generates a live
  // resize — dragged stays true so onUp's resize branch is never entered.
  handle.addEventListener("keydown",e=>{
    if(e.key!=="Enter"&&e.key!==" ") return;
    e.preventDefault();
    if(collapsed){ setCollapsed(false); root.style.setProperty(cssVar, lastExpandedW+"px"); }
  });
}
wireResizeHandle($("#resizeSidebar"),"--sidebar-w",180,480,false,28);
wireResizeHandle($("#resizeDetail"),"--detail-w",240,560,true,28);

// theme
function applyTheme(name){ document.documentElement.setAttribute("data-theme",name); readTheme(); saveSettings({themeMode:name}); }
// "system" removes the explicit override entirely, letting index.html's own
// `@media(prefers-color-scheme:dark)` rule decide — see settings.svelte.ts's
// header doc for why this (and applyTheme above) persist via localStorage
// rather than a new Rust settings file.
function applyThemeMode(mode){
  if(mode==="system"){ document.documentElement.removeAttribute("data-theme"); readTheme(); saveSettings({themeMode:"system"}); }
  else applyTheme(mode);
}
// Whether the canvas draws EVERY ref chip on a commit row (multiple tags
// included) or just the first one (this app's original, still-default
// behavior) — read once per draw() call (a cached flag, not loadSettings()
// itself: draw() runs every animation frame, and loadSettings() does a
// localStorage read + JSON.parse per call, wasteful in a hot per-frame loop).
// settings.svelte.ts's setShowAllCommitTags calls this live, exactly like
// applyThemeMode above; boot seeds it from the persisted value below.
let showAllTags=false;
function setGraphShowAllTags(v){ showAllTags=v; dirty=true; }
$("#themeBtn").addEventListener("click",()=>{
  const cur=document.documentElement.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light");
  applyTheme(cur==="dark"?"light":"dark");
});
// model-rendered Tama celebration popover
let cheerT=null;
function cheer(msg,img: string|null=null){ $("#tamaCheerTxt").innerHTML=msg; $("#tamaCheerImg").src=img||TAMA_IMG.happy; const c=$("#tamaCheer"); c.classList.add("show");
  clearTimeout(cheerT); cheerT=setTimeout(()=>c.classList.remove("show"),3600); }
// global undo (undo-is-itself-undoable)
async function globalUndo(){
  if(!IN_TAURI){ Tama.event("undo.performed",{hash:hhex(1)}); pulseTick(0);
    cheer('Rewound — <b>nothing lost</b>. <span class="jp">やったー♪</span>',TAMA_IMG.confident); return; }
  if(!CUR_REPO){ Tama.warn("Open a repository first — there's nothing to undo yet."); return; }
  // Bug-B fix: right after a successful stash apply/pop, the working tree is
  // dirty in a way the generic undo_last can never rewind — nothing at the
  // ref level moved (see stash_undo_apply's doc comment, workdir.rs), so
  // undo_last would either no-op or restore the WRONG thing. workdirCtrl
  // tracks exactly this (pendingStashUndo, invalidated by any other
  // stage/unstage/discard/commit/stash action since — see workdir.svelte.ts's
  // file-header comment) and undoKind() is the pure read of it; check it
  // BEFORE the Safety.snaps guard below, since that guard is about the
  // ref-snapshot list undo_last relies on and has nothing to do with whether
  // there's a stash apply/pop to undo.
  const useStashUndo=workdirCtrl.undoKind()==="stash";
  // #undoBtn is disabled whenever Safety.snaps is empty (see updateBadge()),
  // but ⌘Z bypasses a disabled button entirely — mirror the same check here
  // so the shortcut doesn't round-trip to the backend for a guaranteed no-op.
  // Skipped entirely for the stash-undo path: stash_undo_apply takes its own
  // safety snapshot and needs no prior ref snapshot to already exist.
  if(!useStashUndo&&!Safety.snaps.length){ Tama.warn("Nothing to undo yet — no snapshots have been taken."); return; }
  if(undoBusy) return; undoBusy=true;
  // #undoBtn's disabled state was previously driven ONLY by Safety.updateBadge()
  // (zero-snapshot check) — undoBusy guarded re-entrancy in code but gave zero
  // visible feedback (not even Tama's corner mascot) for however long undo_last
  // + the follow-up reloadGraph took.
  const btn=$("#undoBtn"), labelEl=btn.querySelector("span"), label=labelEl.innerHTML;
  btn.disabled=true; labelEl.innerHTML='<span class="spinner"></span> Undoing…';
  Tama.set("thinking");
  try{
    // Typed client (commands.stashUndoApply) for the new branch per the fix
    // design; the pre-existing undo_last branch is untouched (still the raw
    // tinvoke() call) — every other operation's Undo behavior stays exactly
    // as it was.
    const res=useStashUndo?await commands.stashUndoApply(CUR_REPO):await tinvoke("undo_last",{path:CUR_REPO});
    if(useStashUndo) workdirCtrl.pendingStashUndo=false; // consumed regardless of outcome — see doc comment above
    if(res&&res.ok){
      // stash_undo_apply never moves HEAD/branches (see its doc comment) —
      // reloading the commit graph would be a no-op for it, so refresh the
      // workdir panel's own status/stash list instead, same as
      // applyOrPopStash's own success path does.
      if(useStashUndo){ await workdirCtrl.refreshStatus(CUR_REPO); await workdirCtrl.refreshStashes(CUR_REPO); }
      else await reloadGraph(true);
      const to=(res.restoredTo||"").slice(0,7);
      Tama.event("undo.performed",{hash:to||hhex(1)}); pulseTick(0);
      cheer('Rewound — <b>nothing lost</b>. <span class="jp">やったー♪</span>',TAMA_IMG.confident);
    } else { Tama.warn((res&&res.message)||"Nothing to undo — no snapshots yet."); }
  }catch(e){ Tama.warn("Undo failed — "+e); console.error(e); }
  finally{ undoBusy=false; labelEl.innerHTML=label; Safety.updateBadge(); }
}
$("#undoBtn").addEventListener("click",globalUndo);
document.addEventListener("keydown",e=>{ if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="z"&&!e.target.closest("input,textarea,[contenteditable=true]")){e.preventDefault();globalUndo();} });

// remote sync: fetch / pull (ff-only) / push — one shared busy flag so an
// in-flight network op can't overlap with another (see src-tauri/src/git_remote.rs
// for why fetch/push never snapshot but pull does).
let syncBusy=false;
// All three buttons dim while ANY one is in flight (they share syncBusy) —
// only the one actually clicked gets the spinner + verb-label swap.
function setSyncButtonsBusy(activeId,busyLabel){
  ["fetchBtn","pullBtn","pushBtn"].forEach(id=>{
    const b=$("#"+id); if(!b) return;
    b.disabled=true;
    if(id===activeId){ b.dataset.label=b.innerHTML; b.innerHTML='<span class="spinner"></span> '+busyLabel; }
  });
}
function clearSyncButtonsBusy(){
  ["fetchBtn","pullBtn","pushBtn"].forEach(id=>{
    const b=$("#"+id); if(!b) return;
    b.disabled=false;
    if(b.dataset.label){ b.innerHTML=b.dataset.label; delete b.dataset.label; }
  });
}
async function doFetch(){
  if(!IN_TAURI){ Tama.set("hint"); Tama.say("Fetched (demo). にゃ〜",3200); return; }
  if(!CUR_REPO){ Tama.warn("Open a repository first."); return; }
  if(syncBusy) return; syncBusy=true;
  setSyncButtonsBusy("fetchBtn","Fetching…");
  Tama.set("syncing"); Tama.say("Fetching…");
  try{
    const res=await tinvoke("fetch",{path:CUR_REPO,remote:null});
    if(res&&res.ok){ await sidebarCtrl.refresh(CUR_REPO); Tama.set("hint"); Tama.say(res.message||"Fetched.",3200); }
    else Tama.warn((res&&res.message)||"Fetch failed.");
  }catch(e){ Tama.warn("Fetch failed — "+e); console.error(e); }
  finally{ syncBusy=false; clearSyncButtonsBusy(); }
}
async function doPull(){
  if(!IN_TAURI){ Tama.set("celebrate"); Tama.say("Pulled (demo). にゃ〜",3200); cheer('Pulled (demo). <span class="jp">にゃ〜</span>',TAMA_IMG.happy); return; }
  if(!CUR_REPO){ Tama.warn("Open a repository first."); return; }
  if(syncBusy) return; syncBusy=true;
  setSyncButtonsBusy("pullBtn","Pulling…");
  Tama.set("syncing"); Tama.say("Pulling…");
  try{
    const res=await tinvoke("pull",{path:CUR_REPO});
    if(res&&res.ok){ await reloadGraph(true); Tama.set("celebrate"); Tama.say(res.message||"Pulled.",3200); cheer(res.message||"Pulled.",TAMA_IMG.happy); }
    else Tama.warn((res&&res.message)||"Pull failed.");
  }catch(e){ Tama.warn("Pull failed — "+e); console.error(e); }
  finally{ syncBusy=false; clearSyncButtonsBusy(); }
}
async function doPush(){
  if(!IN_TAURI){ Tama.set("celebrate"); Tama.say("Pushed (demo). にゃ〜",3200); cheer('Pushed (demo). <span class="jp">にゃ〜</span>',TAMA_IMG.happy); return; }
  if(!CUR_REPO){ Tama.warn("Open a repository first."); return; }
  if(syncBusy) return; syncBusy=true;
  setSyncButtonsBusy("pushBtn","Pushing…");
  Tama.set("syncing"); Tama.say("Pushing…");
  try{
    const res=await tinvoke("push",{path:CUR_REPO});
    if(res&&res.ok){ await sidebarCtrl.refresh(CUR_REPO); Tama.set("celebrate"); Tama.say(res.message||"Pushed.",3200); cheer(res.message||"Pushed.",TAMA_IMG.happy); }
    else Tama.warn((res&&res.message)||"Push failed.");
  }catch(e){ Tama.warn("Push failed — "+e); console.error(e); }
  finally{ syncBusy=false; clearSyncButtonsBusy(); }
}
$("#fetchBtn").addEventListener("click",doFetch);
$("#pullBtn").addEventListener("click",doPull);
$("#pushBtn").addEventListener("click",doPush);

// filter-repo danger gate
let dangerCtx=null;
function armDanger(ctx){
  dangerCtx=ctx;
  $("#dangerTitle").textContent=ctx.title;
  $("#dangerDesc").textContent=ctx.desc;
  const st=$("#dangerSteps"); if(st) st.style.display=ctx.steps===false?"none":"";
  const lose=$("#dangerLose"); lose.innerHTML=ctx.lose||""; lose.style.display=ctx.lose?"":"none";
  const note=$("#dangerNote"); note.innerHTML=ctx.note||""; note.style.display=ctx.note?"":"none";
  $("#dangerTypeName").textContent=ctx.name;
  const inp=$("#confirmInput"); inp.placeholder=ctx.name; inp.value="";
  $("#dangerGo").textContent=ctx.confirmLabel||"Confirm"; $("#dangerGo").disabled=true;
  openScrim("#dangerScrim"); setTimeout(()=>inp.focus(),30);
}
function disarmDanger(){ closeScrim("#dangerScrim"); const ci=$("#confirmInput"); if(ci) ci.value=""; const gg=$("#dangerGo"); if(gg) gg.disabled=true; dangerCtx=null; }
$("#confirmInput").addEventListener("input",e=>{ const want=dangerCtx?dangerCtx.name:"main"; $("#dangerGo").disabled=e.target.value.trim()!==want; });
$("#dangerCancel").addEventListener("click",()=>{ disarmDanger(); Tama.event("mutation.cancel"); });
let dangerBusy=false;
$("#dangerGo").addEventListener("click",async ()=>{
  if(dangerBusy) return;
  const ctx=dangerCtx;
  if(!ctx||!ctx.onConfirm) { disarmDanger(); return; }
  dangerBusy=true;
  const go=$("#dangerGo"), cancel=$("#dangerCancel"), inp=$("#confirmInput");
  const label=go.textContent;
  go.disabled=true; go.innerHTML='<span class="spinner"></span> Working…';
  cancel.disabled=true; if(inp) inp.disabled=true;
  try{ await ctx.onConfirm(); }
  finally{
    dangerBusy=false;
    go.textContent=label; cancel.disabled=false; if(inp) inp.disabled=false;
    disarmDanger();
  }
});
function openScrim(sel){$(sel).classList.add("on");}
function closeScrim(sel){$(sel).classList.remove("on");}
document.addEventListener("keydown",e=>{ if(e.key==="Escape"){ disarmDanger(); } });
// perf controls
$("#rowsSel").addEventListener("change",e=>loadGraph(+e.target.value));
$("#stressBtn").addEventListener("click",e=>{state.stress=!state.stress;e.target.innerHTML=state.stress?"&#9646;&#9646; stress":"&#9654; stress";});
// dev-only perf HUD (fps/ms readout, demo row-count picker, stress test) —
// meaningless in a real production build against a real repo, so hide it
// there; the cherry-pick record-origin toggle stays visible always (a real
// per-session preference, not a debug tool). Zoom buttons used to be a
// third item here too — removed outright (⌘/ctrl+wheel and +/- already
// zoom, see zoomAt()'s own call sites below), not just hidden in prod, so
// there's no "if(!import.meta.env.DEV)" listener for them to guard here.
// Hides #perf itself, NOT just the inner #perfDevTools span: #perfDevTools
// is #perf's only child, so hiding just the child left the OUTER box (its
// own background/border/shadow/padding) empty but still visible — a blank
// chip sitting over the top-right corner of the graph in every release
// build, with nothing inside it to explain why it was there.
if(!import.meta.env.DEV) $("#perf").style.display="none";
// #devBadge (top-left "DEV" pill, see its own index.html doc comment) is the
// OPPOSITE default from #perf just above — display:none in the markup,
// shown here only when true — a deliberate fail-safe: if this line never
// ran at all (script error, disabled JS), a real `tauri build` never shows
// a dev indicator it can't back up, where #perf's own "visible by default,
// hidden here" would fail the OTHER way (a debug HUD stuck on in prod).
if(import.meta.env.DEV) $("#devBadge").style.display="flex";

/* ---- snapshot ribbon: recent ticks positioned by ACTUAL elapsed time,
   with a zoomable time window ----
   Ticks used to sit at fixed equal-interval positions regardless of when
   each snapshot actually happened — a burst of five snapshots in the last
   minute and a sixth from three days ago looked exactly as "evenly spread
   out" as six snapshots one hour apart each. Real usage is bursty (lots of
   mutations in one session, then a long gap), so equal spacing carried no
   information about *when* things happened at all.
   ribbonTickFracs() log-compresses elapsed time (log1p, not linear) so a
   recent burst still spreads out near the top while a long tail of older
   snapshots compresses toward the bottom instead of being pushed off
   entirely — then walks top-to-bottom enforcing a minimum pixel gap, so
   same-second (or very close) snapshots never visually overlap.
   ribbonWindowSec is the time RANGE currently shown, not just visual
   density — wheel-zoom over the ribbon (mirrors the graph's own wheel-zoom)
   narrows it (scroll up: fewer, more recent, more spread out) or widens it
   (scroll down: further back, more compressed), dropping anything outside
   the window out of view entirely, same as zooming a real timeline/calendar
   view. Starts at `null` — auto-fit to whichever full range already exists
   — so the very first render already shows everything available (no more
   flat 8-tick cap) rather than requiring a zoom just to see more. Double-
   click the ribbon to reset back to auto-fit. */
const RIBBON_MIN_TICK_PX=7, RIBBON_TOP_FRAC=0.08, RIBBON_BOT_FRAC=0.92;
const RIBBON_WINDOW_MIN=300, RIBBON_WINDOW_MAX=180*86400; // 5 minutes .. ~6 months
let ribbonWindowSec=null; // null = auto-fit; a number once the user has zoomed

function ribbonTickFracs(agesAscending,H){
  const maxAge=Math.max(1,...agesAscending);
  const span=RIBBON_BOT_FRAC-RIBBON_TOP_FRAC;
  const fracs=agesAscending.map(age=>RIBBON_TOP_FRAC+span*(Math.log1p(Math.max(0,age))/Math.log1p(maxAge)));
  const minGap=RIBBON_MIN_TICK_PX/H;
  for(let i=1;i<fracs.length;i++){ if(fracs[i]<fracs[i-1]+minGap) fracs[i]=fracs[i-1]+minGap; }
  return fracs;
}
function ribbonWindowLabel(sec){
  if(sec<3600) return Math.max(1,Math.round(sec/60))+"m";
  if(sec<86400) return Math.round(sec/3600)+"h";
  if(sec<86400*90) return Math.round(sec/86400)+"d";
  return Math.round(sec/(86400*30))+"mo";
}
function positionTicks(){ const rb=$("#ribbon"); $$(".tick",rb).forEach(t=>t.remove());
  const H=rb.clientHeight; if(!H) return;
  // Cap sized so the worst case (every tick pushed to the minimum gap)
  // still fits the usable band — scales with window height instead of a
  // flat number that ignored how much room was actually available.
  const cap=Math.max(6,Math.floor(((RIBBON_BOT_FRAC-RIBBON_TOP_FRAC)*H)/RIBBON_MIN_TICK_PX));
  const now=Date.now()/1000, label=$("#ribbonWindow");
  if(IN_TAURI){
    const all=Safety.snaps;
    if(!all.length){ if(label) label.textContent=""; return; }
    const oldestAge=Math.max(1,now-all[all.length-1].ts);
    const windowSec=Math.max(RIBBON_WINDOW_MIN,Math.min(ribbonWindowSec??oldestAge,RIBBON_WINDOW_MAX));
    if(label) label.textContent=ribbonWindowLabel(windowSec);
    const within=all.filter(s=>now-s.ts<=windowSec).slice(0,cap);
    if(!within.length) return;
    const fracs=ribbonTickFracs(within.map(s=>Math.max(0,now-s.ts)),H);
    within.forEach((s,i)=>{ const f=fracs[i];
      const ago=relTime(s.ts).replace(" ago",""), sha=(s.sha||"").slice(0,7), sub=(s.subject||"snapshot");
      // No native title: it's unclipped/unstyleable and, this close to the
      // narrow ribbon, renders past its edge on top of the graph's own text
      // — #deltaReadout (below) already shows the same info, safely
      // contained in a fixed corner of the canvas.
      const t=document.createElement("div"); t.className="tick"; t.style.top=(f*H)+"px";
      t.addEventListener("mouseenter",()=>{const d=$("#deltaReadout");d.textContent=ago+" ago · "+sha+" · "+sub.slice(0,48);d.classList.add("show");});
      t.addEventListener("mouseleave",()=>$("#deltaReadout").classList.remove("show"));
      t.addEventListener("click",()=>pulseTick(i));
      rb.appendChild(t); });
    return;
  }
  // Design-mode preview: synthetic snapshots at deliberately UNEVEN ages
  // (seconds through months) so the log-scale compression AND the zoom
  // window are both visible without a real repo.
  const demoAgesAll=[15,55,150,420,1200,3600,10800,32400,86400,216000,450000,1200000,4000000,9000000];
  const oldestAge=demoAgesAll[demoAgesAll.length-1];
  const windowSec=Math.max(RIBBON_WINDOW_MIN,Math.min(ribbonWindowSec??oldestAge,RIBBON_WINDOW_MAX));
  if(label) label.textContent=ribbonWindowLabel(windowSec);
  const demoAges=demoAgesAll.filter(age=>age<=windowSec).slice(0,cap);
  if(!demoAges.length) return;
  const fracs=ribbonTickFracs(demoAges,H);
  demoAges.forEach((age,i)=>{ const f=fracs[i];
    const t=document.createElement("div"); t.className="tick"; t.style.top=(f*H)+"px";
    t.addEventListener("mouseenter",()=>{const d=$("#deltaReadout");d.textContent="main −"+(i+1)+" · HEAD moved · "+(1+i%3)+" refs changed";d.classList.add("show");});
    t.addEventListener("mouseleave",()=>$("#deltaReadout").classList.remove("show"));
    t.addEventListener("click",()=>{pulseTick(i);Tama.event("undo.performed",{hash:hhex(i+2)});});
    rb.appendChild(t); }); }
function pulseTick(i){const ticks=$$(".tick");const t=ticks[i]||ticks[0];if(t){t.classList.remove("pulse");void t.offsetWidth;t.classList.add("pulse");}}
$("#ribbon").addEventListener("wheel",e=>{
  e.preventDefault();
  const H=$("#ribbon").clientHeight; if(!H) return;
  if(ribbonWindowSec==null){
    // First zoom: seed from whatever's auto-fit right now, so it zooms
    // FROM the current view instead of jumping from some arbitrary default.
    if(IN_TAURI){ const all=Safety.snaps; ribbonWindowSec=all.length?Math.max(1,Date.now()/1000-all[all.length-1].ts):RIBBON_WINDOW_MIN; }
    else ribbonWindowSec=9000000;
  }
  ribbonWindowSec=Math.max(RIBBON_WINDOW_MIN,Math.min(RIBBON_WINDOW_MAX,ribbonWindowSec*Math.exp(e.deltaY*0.0016)));
  positionTicks();
},{passive:false});
$("#ribbon").addEventListener("dblclick",()=>{ ribbonWindowSec=null; positionTicks(); });

/* ---- shared is-interacting flag → hard-pause Tama during pan/zoom ---- */
["wheel","pointerdown"].forEach(ev=>wrap.addEventListener(ev,()=>{},{passive:true}));

/* ============================================================
   10) FRAME LOOP + FPS meter
   ============================================================ */
function tick(now){
  const dt=now-perf.last; perf.last=now;
  if(Math.abs(state.scrollTarget-state.scrollTop)>0.4){state.scrollTop+=(state.scrollTarget-state.scrollTop)*0.3;dirty=true;}
  else state.scrollTop=state.scrollTarget;
  if(Math.abs(state.panTarget-state.panX)>0.4){state.panX+=(state.panTarget-state.panX)*0.3;dirty=true;}
  else state.panX=state.panTarget;
  if(state.stress){state.scrollTarget+=9;if(state.scrollTarget>=state.maxScroll)state.scrollTarget=0;dirty=true;}
  const selTarget=state.selectedRow>=0?0.20:0, hovTarget=(state.hoverRow>=0&&state.hoverRow!==state.selectedRow)?0.08:0;
  if(REDUCE_MOTION){ state.selectAlpha=selTarget; state.hoverAlpha=hovTarget; }
  else{
    if(Math.abs(selTarget-state.selectAlpha)>0.003){state.selectAlpha+=(selTarget-state.selectAlpha)*0.35;dirty=true;} else state.selectAlpha=selTarget;
    if(Math.abs(hovTarget-state.hoverAlpha)>0.003){state.hoverAlpha+=(hovTarget-state.hoverAlpha)*0.35;dirty=true;} else state.hoverAlpha=hovTarget;
  }
  state.isInteracting=dirty||state.pointerActive;
  if(state.isInteracting!==lastInteracting){Tama.setInteracting(state.isInteracting);lastInteracting=state.isInteracting;}
  if(dirty){draw();dirty=false;}
  perf.frames++; perf.accum+=dt;
  if(perf.accum>=400){ perf.fps=perf.frames*1000/perf.accum; perf.frames=0; perf.accum=0;
    const first=Math.floor(state.scrollTop/layout.rowH), last=Math.floor((state.scrollTop+view.cssH)/layout.rowH);
    $("#hud").innerHTML=`<b>${perf.fps.toFixed(0)}</b> fps · ${perf.lastDrawMs.toFixed(1)} ms · rows ${first.toLocaleString()}–${Math.min(G.N-1,last).toLocaleString()}`;
  }
  requestAnimationFrame(tick);
}

/* ============================================================
   11) BOOT
   ============================================================ */
// Shared by loadGraph()'s real-repo branch AND onGraphBatch() below (streaming
// growth) — builds the canvas's own `G` shape from whatever `BACKEND` (the
// SoA payload the Rust side sends, real field names) currently holds. Pulled
// out so growing G on every streaming batch doesn't duplicate this refs/
// allRefs-mapping logic. snapRows/snapTs stay empty here exactly like the
// single call site this replaces always left them (see this repo's own
// history: real snapshot coverage was never wired onto the canvas — only
// generateGraph()'s synthetic demo path ever populates them).
// One backend RefChip ({n,t}) -> the canvas's own chip shape.
function toChip(rc){ return {label:rc.n, kind:(rc.t==="tag"?"tag":rc.t==="head"?"head":rc.t==="remote"?"remote":"branch")}; }
// ADVERSARIALLY-FOUND FIX: onGraphBatch() used to append each batch's arrays
// via `dst.push(...src)` — spreading `src` into individual call arguments.
// `rows`/`lane`/`color`/`merge` are always exactly `batch_size` long (safe),
// but a batch's gap-segment count (gapTop/gapBot/gapColor) is NOT capped by
// batch_size — it scales with how many lanes are simultaneously active where
// that batch falls in history, which for a repo with genuinely wide/complex
// branching (many long-lived branches — e.g. a real checkout of CPython, not
// the linear synthetic repos this was benchmarked against) can run into the
// tens of thousands PER BATCH. Spreading an array that large into a function
// call hits JS engines' own argument-count limit and throws ("Maximum call
// stack size exceeded" or similar) — silently crashing onGraphBatch mid-
// batch, before BACKEND/G ever get updated and before `dirty` is ever set,
// which is exactly consistent with "Loading repository…" never clearing: the
// very first wide batch could crash before the canvas ever gets real data.
// A plain loop has no such limit regardless of array size.
function appendAll(dst, src){ for(let i=0;i<src.length;i++) dst.push(src[i]); }
// g.refs/g.allRefs are ALREADY fully populated by the time this runs — see
// startGraphStream() (seeds them empty) / onGraphBatch() (appends only the
// NEW rows' chips per batch) — never recomputed here from g.rows.
//
// ADVERSARIALLY-FOUND FIX: this used to re-derive refs/allRefs from g.rows
// via a full .map() on EVERY call, including every single streaming batch —
// harmless for the one-shot old design, but for a streaming 100k+-commit
// repo (e.g. a real checkout of CPython) that turned "grow G by one more
// batch" into "re-map the ENTIRE row list so far," making the total cost
// across ~100 batches roughly QUADRATIC (batch 1 remaps 1k rows, batch 50
// remaps 50k, batch 100 remaps 100k) — slower overall than the old single
// O(n) pass, not faster. allRefs: every ref on the row, not just the first —
// the backend already collects all of them (row.refs is a full Vec<RefChip>,
// see git_read.rs's collect_refs). Kept as a SEPARATE field (not a shape
// change to refs itself) since detail.svelte.ts/cmdk.svelte.ts's own G.refs
// fallback paths (no-BACKEND synthetic data only) still expect refs'
// original one-object-or-null shape.
function buildGFromBackend(g){
  return {N:g.n, commitLane:g.lane, commitColor:g.color, isMerge:g.merge,
     gapStart:g.gapStart, gapTop:g.gapTop, gapBot:g.gapBot, gapColor:g.gapColor, refs:g.refs, allRefs:g.allRefs, snapRows:[], snapTs:{},
     // recomputeLayout() reads this to size horizontal panning range (see
     // state.panX's own doc comment) — without it, G.laneCount was
     // undefined for every real repo, turning state.maxPanX into NaN.
     laneCount:g.laneCount};
}
function loadGraph(N){
  resize(); // ensure the canvas matches the current wrap size (cold Tauri windows can report 0×0 at boot)
  const t0=performance.now(); let NN, ms;
  if(BACKEND){
    G=buildGFromBackend(BACKEND);
    NN=BACKEND.n; ms=performance.now()-t0;
  } else { G=generateGraph(N); NN=N; ms=performance.now()-t0; }
  state.selectedRow=-1; state.hoverRow=-1; state.scrollTop=state.scrollTarget=0; state.panX=state.panTarget=0;
  bisectDrawerCtrl.clearLocalMarks();
  recomputeLayout(); positionTicks();
  detailCtrl.showHero(NN, ms);
  Tama._tele(); dirty=true;
}
/* ============================================================
   12) REAL REPOSITORY (Tauri): open a repo -> Rust load_graph
   ============================================================ */
// Kick off a STREAMING graph load for `path` — load_graph itself now returns
// almost immediately with just a generation id (see src-tauri/src/commands.rs's
// own doc comment on why: the old design walked/laid-out/serialized the WHOLE,
// 50,000-commit-capped history before responding at all). Resets BACKEND to an
// empty-but-valid shape (same field names load_graph's old one-shot response
// used) so loadGraph(0) right after this still works unchanged, and bumps
// graphGeneration so onGraphBatch() below can tell this stream's batches apart
// from whatever a still-winding-down PREVIOUS stream might still deliver.
// ADVERSARIALLY-FOUND FIX: load_graph used to generate its OWN generation id
// server-side and hand it back as this command's return value — but the
// background walk it spawns starts running (on a separate OS thread)
// immediately, and can emit its very FIRST "graph-batch" event before this
// command's own IPC round-trip even finishes. graphGeneration was only ever
// set here AFTER `await tinvoke(...)` resolved, so that first event (the one
// specifically responsible for hiding the "Loading repository…" overlay —
// see onGraphBatch's own doc comment) would arrive while graphGeneration
// still held the PREVIOUS repo's id, get rejected as stale, and the overlay
// would keep spinning well past when real data had actually started
// streaming in. Now this file owns the id (a simple monotonic counter) and
// records it SYNCHRONOUSLY, before the `await` even starts, so no event can
// ever arrive "too early" relative to it.
let graphRequestSeq=0;
async function startGraphStream(path){
  const myGen = ++graphRequestSeq;
  graphGeneration = myGen;
  BACKEND = { n:0, lane:[], color:[], merge:[], gapStart:[0], gapTop:[], gapBot:[], gapColor:[], rows:[], refs:[], allRefs:[], ncol:7, laneCount:0 };
  await tinvoke("load_graph", { path, requestId: myGen });
  return myGen;
}
// "graph-batch" event handler (registered once in src/main.ts, mirroring its
// own "repo-changed" listener) — grows BACKEND/G with one incremental slice
// at a time as the backend's revwalk+layout produces it, instead of the old
// "wait for one giant response, then populate everything at once" shape.
//
// G is REASSIGNED (a new object) on every batch, never mutated in place —
// load-bearing, not just style: cmdk.svelte.ts's own search-index cache
// (`show()`'s `cacheG !== bridge.G` check) only rebuilds when G's object
// REFERENCE changes, so an in-place mutation here would make ⌘K permanently
// stop discovering any commit that streamed in after the first time it was
// ever opened.
//
// G.N is kept in EXACT lockstep with how many rows/lane/color/merge entries
// are actually present after each batch — never ahead of them. draw()'s own
// per-row indexing (G.commitLane[r] etc.) is NOT null-safe the way
// hhex()/msgOf()/authorOf() are (see those functions' own doc comments): an
// out-of-range read silently draws nothing (NaN canvas coordinates), so this
// invariant is what keeps that indexing safe by construction rather than
// needing new bounds checks sprinkled through draw() itself.
function onGraphBatch(payload){
  if(!payload || payload.generation!==graphGeneration || !BACKEND) return; // stale/superseded — ignore

  // ADVERSARIALLY-FOUND FIX: the "Loading repository…" overlay used to only
  // hide in openRepo()'s own `finally`, which doesn't run until its ENTIRE
  // tail finishes — sidebarCtrl.refresh, Safety.refresh, bisectCtrl.probeOnOpen,
  // AND repoSummaryCtrl.maybeAutoShow (which, on a repo's first-ever open, runs
  // its OWN separate blocking git-log walk, up to 20,000 commits). Streaming
  // load_graph itself didn't help this overlay at all — it just made the
  // canvas underneath it start filling in faster while the spinner stayed up
  // regardless, for a real large repo (e.g. CPython's own history) easily
  // outlasting the graph load itself. The overlay's actual job is just "the
  // canvas has nothing current to show yet" — true from the empty
  // loadGraph(0) right after startGraphStream() until THIS, the first real
  // batch, arrives; hiding it here (not in openRepo()'s finally, which still
  // hides it too, as a fallback for the open-FAILED path where no batch ever
  // arrives at all) is what actually fixes the perceived wait.
  const graphLoading=$("#graphLoading");
  if(graphLoading) graphLoading.style.display="none";

  appendAll(BACKEND.rows, payload.rows);
  appendAll(BACKEND.lane, payload.lane);
  appendAll(BACKEND.color, payload.color);
  appendAll(BACKEND.merge, payload.merge);
  // Incrementally append THIS batch's own refs/allRefs chips — O(batch size),
  // not O(total rows so far). See buildGFromBackend's own doc comment for why
  // that distinction is exactly what keeps a big streamed repo's total cost
  // linear instead of quadratic.
  for(const row of payload.rows){
    BACKEND.refs.push(row.refs.length ? toChip(row.refs[0]) : null);
    BACKEND.allRefs.push(row.refs.map(toChip));
  }
  // Rebuild the running CSR gapStart index from this batch's own per-row
  // gapCounts — the wire protocol never transmits gapStart itself (see
  // model.rs's own GraphBatch doc comment), only enough to reconstruct it
  // incrementally, the same way this loop's cumulative sum works.
  let idx=BACKEND.gapTop.length;
  for(const count of payload.gapCounts){ idx+=count; BACKEND.gapStart.push(idx); }
  appendAll(BACKEND.gapTop, payload.gapTop);
  appendAll(BACKEND.gapBot, payload.gapBot);
  appendAll(BACKEND.gapColor, payload.gapColor);
  BACKEND.n = BACKEND.rows.length;
  BACKEND.ncol = payload.ncol;
  BACKEND.laneCount = payload.laneCount;

  G=buildGFromBackend(BACKEND);
  recomputeLayout(); // grows contentH/maxScroll to match the now-larger G.N
  detailCtrl.showHero(BACKEND.n, payload.elapsedMs); // live-updating "N commits laid out in M ms"
  dirty=true;
  // ADVERSARIALLY-FOUND FIX: a real repo with a wide/dense stretch of history
  // (many simultaneously open branch lanes) can have the backend emit dozens
  // of "graph-batch" events within a handful of milliseconds — each one
  // individually cheap, but back-to-back IPC event dispatches can occupy the
  // main thread long enough that the separate requestAnimationFrame loop
  // (tick(), which is what actually notices `dirty` and calls draw()) never
  // gets a turn until the whole burst drains. The user-visible result: the
  // canvas stays on whatever it last painted (often still blank, right after
  // the loading overlay's own hide) for the ENTIRE burst, then the fully-
  // streamed graph pops in all at once once things quiet down — instead of
  // growing visibly, incrementally, the way each individual batch arriving
  // should look. Forcing a real (not just dirty-flagged) draw() here, but
  // throttled to roughly one per frame, guarantees the canvas keeps actually
  // painting DURING a burst rather than only after it, without redundantly
  // redrawing far more often than the display can even show.
  const __now=performance.now();
  if(payload.done || __now-lastForcedDrawAt>=16){ lastForcedDrawAt=__now; draw(); dirty=false; }

  if(payload.done){
    if(payload.error){ Tama.warn("Loading history stopped early — "+payload.error,5000); }
    // Distinct from a genuine walk error (above) — the walk didn't fail, it
    // just has more history than commands.rs's MAX_LIVE_COMMITS is willing
    // to hold in memory at once. Surfacing this explicitly matters: without
    // it, a capped load looks byte-for-byte identical to a real "that's the
    // whole history" finish, silently hiding the fact that older commits
    // past this point aren't loaded (and won't be found by search/⌘K/jump-
    // to-commit either).
    else if(payload.truncated){ Tama.set("curious"); Tama.warn("Loaded the most recent "+BACKEND.n.toLocaleString()+" commits — this repo's history is even longer, capped here to limit memory usage.",6500); }
    else { Tama.set("curious"); Tama.say("Loaded "+BACKEND.n.toLocaleString()+" commits in "+payload.elapsedMs.toFixed(0)+" ms. にゃ〜",4200); }
    if(pendingReselect){
      if(pendingReselect.sha){
        const row=BACKEND.rows.findIndex(r=>r.sha===pendingReselect.sha);
        // Center within the scrollable viewport BELOW the pinned header
        // (view.cssH-bandH()), not the full canvas height — see bandH()'s comment.
        if(row>=0){ select(row); state.scrollTarget=clampScroll(row*layout.rowH-(view.cssH-bandH())/2); dirty=true; }
      } else if(pendingReselect.workdir){ selectWorkdir(); }
      pendingReselect=null;
    }
  } else if(BACKEND.n<=(payload.rows.length)){
    // First batch of a fresh stream — a lighter-weight "still going" hint
    // than the final toast above, so a big repo doesn't look hung between
    // "Loading…" and "Loaded" while the rest streams in.
    Tama.set("thinking"); Tama.say("Loading history… "+BACKEND.n.toLocaleString()+" so far…",4200);
  }
}
// Last path segment of an absolute repo path, for display only (e.g. the
// ".repo-pick" folder-name label, and the "← Back to <parent repo name>"
// affordance below) — the ONE place this trimming/splitting happens, reused
// everywhere a repo path needs to become a short display name rather than
// re-deriving it ad hoc at each call site.
function repoBasename(path){ return path.replace(/[\/\\]+$/,"").split(/[\/\\]/).pop() || path; }
// Returns true when the repo actually loaded, false when load_graph (or any
// step) failed. Never throws — callers that don't care (pickRepo) can ignore
// the result, while the setup wizard uses it to keep its done-step overlay up
// so the user can retry "Open repository" instead of being dumped out silently.
let openRepoBusy=false;
async function openRepo(path){
  if(openRepoBusy) return false;
  openRepoBusy=true;
  // An automated bisect run (bisect_run_start) is a real, long-lived blocking
  // Tauri call actually executing the user's command against THIS repo's
  // working tree. Switching repos out from under it would leave it running
  // headlessly against a repo the UI can no longer see or stop, with
  // "bisect-run-progress" events silently misapplied once CUR_REPO moves on
  // below — so request cancellation first (best-effort, see
  // bisectCtrl.cancelIfRunning's own documented TOCTOU note).
  await bisectCtrl.cancelIfRunning();
  const pickBtn=$(".repo-pick");
  const backBtn=$("#backToParentBtn");
  let pickSpinner=null;
  if(pickBtn){ pickBtn.disabled=true; pickSpinner=document.createElement("span"); pickSpinner.className="spinner"; pickBtn.insertBefore(pickSpinner,pickBtn.firstChild); }
  // Also disable the "← Back to …" affordance (if shown) for the same
  // re-entrancy reason as pickBtn above — it triggers openRepo() too (via
  // goBackToParent), just from a different button.
  if(backBtn) backBtn.disabled=true;
  // The graph canvas keeps rendering whichever repo was open before (see
  // index.html's own comment on #graphLoading) — nothing else in the main
  // frame otherwise hints that it's showing stale data while load_graph is
  // in flight. Same show/hide lifecycle as pickSpinner above (finally,
  // below), not just around loadGraph() — Dashboard.svelte's own
  // openRepository() closes its modal BEFORE awaiting this whole function,
  // so this overlay is the only cue left once that modal is gone.
  const graphLoading=$("#graphLoading");
  if(graphLoading) graphLoading.style.display="";
  Tama.set("thinking");
  try{
    // load_graph itself now returns almost instantly (a generation id, not
    // the whole graph — see startGraphStream()'s own doc comment); the OLD
    // double-rAF forced-paint hack here existed specifically to keep the
    // browser from looking hung during the ONE giant, unavoidably-synchronous
    // stretch that response used to require — there's no such stretch left
    // to paint around now that the real data arrives in small streamed
    // batches instead of one big blob.
    await startGraphStream(path);
    CUR_REPO = path;
    // Switching repos must close the pinned "Uncommitted changes" panel (if
    // open) FIRST — its file list belongs to whichever repo was open when
    // select() last populated it. Left open here, it would keep showing the
    // OLD repo's stale files while every Stage/Unstage/Discard/Commit button
    // reads the clicked file path from that stale list combined with the
    // NEW repo path (CUR_REPO, just reassigned above) — silently acting on
    // the wrong repo+file combination. deselect() mirrors bootEmpty()'s own
    // reset sequence; a later selectWorkdir() reopens it against the new repo.
    workdirCtrl.deselect();
    // .repo-name, NOT a bare "span" — this button's loading spinner (just
    // above) is ALSO inserted as its first-child span while this exact
    // openRepo() call is in flight, so a bare ".repo-pick span" selector
    // would match the SPINNER first (document order), silently writing the
    // repo name onto a node `finally` below is about to delete instead of
    // the one actually visible on screen. Empirically confirmed: this was
    // the reason the topbar chip never updated after opening a repo.
    $(".repo-pick .repo-name").textContent = repoBasename(path);
    // Undoes bootEmpty()'s own hide — a no-op unless the repo being opened
    // right now was reached via closeRepo() first.
    const bp=$(".branch-pill"); if(bp) bp.style.display="";
    // BACKEND is still empty at this point (startGraphStream() just reset
    // it) — this paints the canvas's OWN empty/reset state immediately;
    // onGraphBatch() (registered in src/main.ts) takes over from here as
    // "graph-batch" events stream in, growing BACKEND/G and eventually
    // showing the "Loaded N commits…" toast itself once the walk finishes.
    loadGraph(0);
    await sidebarCtrl.refresh(CUR_REPO);
    await Safety.refresh();
    // Live refresh: watch this repo's git-dir for changes made outside the
    // app (terminal commits, another tool, a background fetch) — see
    // src-tauri/src/watch.rs. Best-effort: a watch failure shouldn't block
    // opening the repo, the app still works fine (just without live
    // refresh — the manual Refresh button still forces the same resync).
    // Was console.error-only — a failure here was otherwise invisible unless
    // someone happened to have DevTools open, so live-refresh-not-working
    // reports had no way to distinguish "the watch never armed at all" (a
    // real, surfaced error) from "it armed fine but genuinely saw no fs
    // events" (silent either way, but now at least ONE of the two classes
    // is no longer silent).
    tinvoke("watch_repo",{path}).catch(e=>{ Tama.warn("Live refresh couldn't start for this repo — "+e); console.error("watch_repo",e); });
    // Multi-repo dashboard (backlog #11): auto-track whichever repo was just
    // opened (real open OR submodule nav OR the setup wizard's finish() —
    // every one of them funnels through this one openRepo() success path) so
    // the dashboard's tracked list naturally accumulates "things I've opened"
    // with no per-call-site wiring needed elsewhere. Fire-and-forget, same
    // best-effort reasoning as watch_repo just above — a registry-write
    // failure (e.g. a read-only app config dir) must never block opening the
    // repo itself.
    tinvoke("track_repo_opened",{path}).catch(e=>console.error("track_repo_opened",e));
    // Runs after loadGraph() (which resets the local bisect row-model) so a
    // recovered live bisect's canvas cues aren't immediately wiped out; and
    // after the "Loaded N commits" toast so a recovery notice (if any) is the
    // last, most relevant thing the user sees — it deliberately overrides the
    // generic greeting rather than racing it.
    await bisectCtrl.probeOnOpen(path);
    // Repository Summary: auto-shows itself, but only the very first time
    // THIS path has ever been opened in GitCat (see
    // claim_repo_summary_first_open) — placed last, same "don't race a more
    // relevant notice" reasoning as probeOnOpen immediately above. Best-effort
    // and self-contained (own try/catch), so it can never block opening the
    // repo — same as watch_repo/track_repo_opened above.
    await repoSummaryCtrl.maybeAutoShow(path);
    return true;
  }catch(e){ Tama.warn("Couldn't open that repo — "+e,5000); console.error(e); return false; }
  finally{ openRepoBusy=false; if(pickBtn){ pickBtn.disabled=false; if(pickSpinner) pickSpinner.remove(); } if(backBtn) backBtn.disabled=false; if(graphLoading) graphLoading.style.display="none"; }
}
/* ------------------------------------------------------------
   12a) SUBMODULE NAVIGATION STACK — "enter" a submodule (become its own
   fully active repo, reusing openRepo above verbatim) and "go back" out.
   ------------------------------------------------------------
   Tracks the absolute path of every ancestor repo the user has navigated
   INTO a submodule from. A plain array, exported (live binding, same as
   CUR_REPO above — see bridge.ts's own file header) and always mutated IN
   PLACE (push/pop/length=0), never reassigned: the SAME array object is
   shared with every importer, so there's nothing that could go stale.
   Arbitrary nesting depth is just arbitrary stack depth — entering a
   submodule-of-a-submodule pushes twice, going back twice returns to the
   original top-level repo.
   openRepo() itself deliberately never touches this stack — it's used both
   for "open a fresh repo via the picker" (which must NOT push) and
   internally by both functions below (which push/pop it themselves around
   their own call to openRepo). pickRepo() (below) clears it outright: once
   the user's deliberately left the chain to open something unrelated, going
   back no longer makes sense. */
export let NAV_STACK=[];
// Pushes CUR_REPO (the repo being left) onto NAV_STACK, then opens
// `absolutePath` — straight from SubmoduleInfo.absolutePath (see its own doc
// comment in src/ipc/bindings.ts), never string-concatenated by this file —
// via the SAME openRepo() every "open a repository" path already uses: real
// graph, real workdir panel, real branches/tags/bisect/rebase, even its own
// nested Submodules section. Zero duplicated UI — this repo simply IS the
// submodule now. Only pushes once openRepo() actually reports success (the
// same "don't touch persistent state until the load succeeded" discipline
// openRepo itself uses for CUR_REPO/BACKEND above) so a failed load — bad
// path, the submodule vanished on disk, etc. — doesn't leave a stale,
// unbalanced stack entry that a later goBackToParent() would pop into
// nothing useful.
async function enterSubmodule(absolutePath){
  const parent=CUR_REPO; // capture BEFORE openRepo() reassigns it below
  const ok=await openRepo(absolutePath);
  if(ok){ NAV_STACK.push(parent); updateBackToParentBtn(); }
  return ok;
}
// Pops the most recently pushed ancestor and opens it via openRepo — pushes
// nothing itself (going backward), symmetric with enterSubmodule above. PEEKS
// at the top of NAV_STACK first (does NOT pop yet), and only actually pops +
// updates the button once openRepo reports success — the exact same "don't
// touch persistent state until the load succeeded" discipline enterSubmodule
// uses above. If the parent repo fails to load (transiently locked,
// permission-denied, or actually moved/deleted since it was left), popping
// FIRST would silently drop the stack entry forever: the next Back click
// would skip straight past that level (or, if this was the last entry, the
// Back button would vanish outright) with no way to retry short of the
// folder picker. Leaving NAV_STACK untouched on failure means the user can
// simply click Back again once the transient condition clears.
async function goBackToParent(){
  if(!NAV_STACK.length) return false;
  const parent=NAV_STACK[NAV_STACK.length-1]; // peek — do NOT pop yet
  const ok=await openRepo(parent);
  if(ok){ NAV_STACK.pop(); updateBackToParentBtn(); }
  return ok;
}
// Shows/hides the topbar "← Back to <parent repo name>" affordance and, when
// shown, fills in the name — derived from NAV_STACK's top entry via
// repoBasename() above, the EXACT same name-deriving logic ".repo-pick"'s
// own span already uses for the CURRENT repo, reused rather than
// reinvented. Called at every point NAV_STACK's length can change
// (enterSubmodule/goBackToParent above, pickRepo below) — never on a timer
// or a redraw, so it can never show a stale name.
function updateBackToParentBtn(){
  const btn=$("#backToParentBtn");
  if(!btn) return;
  if(NAV_STACK.length){
    $("#backToParentName").textContent = repoBasename(NAV_STACK[NAV_STACK.length-1]);
    btn.style.display = "";
  } else {
    btn.style.display = "none";
  }
}
// Called from ~10 different sites (every real mutation across every island)
// with no shared lock of its own before this guard — two callers firing back
// to back could overlap two load_graph calls and race on BACKEND/state.
//
// ADVERSARIALLY-FOUND FIX: a call arriving while another is already running
// used to just return early and be silently dropped forever — no queued
// follow-up. That's fine when the caller is about to trigger its OWN later
// reload anyway, but the live-refresh "repo-changed" listener has no such
// second chance: if its reload lands mid-flight behind some other mutation's
// own reloadGraph() call, the external change it was reporting would never
// get reflected until some UNRELATED later action happened to reload again.
// reloadGraphPending remembers "one more reload is owed" and the loop below
// drains it after the in-flight one finishes, coalescing any number of
// overlapping requests into exactly one extra pass — never zero.
let reloadGraphBusy=false;
let reloadGraphPending=false;
let reloadGraphPendingPreserveRow=false;
async function reloadGraph(preserveRow){
  if(!IN_TAURI||!CUR_REPO) return;
  if(reloadGraphBusy){
    reloadGraphPending=true;
    reloadGraphPendingPreserveRow = reloadGraphPendingPreserveRow || !!preserveRow;
    return;
  }
  reloadGraphBusy=true;
  try{
    let nextPreserveRow=preserveRow;
    for(;;){
      const keepSha = nextPreserveRow && state.selectedRow>=0 && BACKEND && BACKEND.rows[state.selectedRow]
        ? BACKEND.rows[state.selectedRow].sha : null;
      // The pinned "Uncommitted changes" row has no sha to re-locate by — its own
      // sentinel (-2) IS the identity, so just remember it was open and reopen it
      // after loadGraph() (which unconditionally resets state.selectedRow to -1)
      // instead of trying (and failing) to find it in BACKEND.rows below.
      const keepWorkdir = nextPreserveRow && state.selectedRow===-2;
      try{
        // Same streaming load openRepo() itself now uses (see
        // startGraphStream()'s own doc comment) — loadGraph(0) here resets to
        // the now-empty BACKEND/selection exactly like a fresh open would;
        // re-selecting keepSha/keepWorkdir has to wait until the stream
        // actually finishes (the previously-selected commit might be deep in
        // history, not necessarily in the very first batch), so it's handed
        // to onGraphBatch() via pendingReselect instead of done inline here.
        await startGraphStream(CUR_REPO);
        loadGraph(0);
        pendingReselect = keepSha ? {sha:keepSha} : (keepWorkdir ? {workdir:true} : null);
        await sidebarCtrl.refresh(CUR_REPO); await Safety.refresh();
      }catch(e){ Tama.warn("Reload failed — "+e); console.error(e); }
      if(!reloadGraphPending) break;
      reloadGraphPending=false;
      nextPreserveRow=reloadGraphPendingPreserveRow;
      reloadGraphPendingPreserveRow=false;
    }
  } finally {
    reloadGraphBusy=false;
  }
}
// Sidebar (refs tree + branch menu) is now a Svelte island (src/islands/sidebar).
// Topbar branch pill stays legacy-owned (a separate future migration) —
// sidebarCtrl.refresh() calls this after every list_refs fetch instead of
// touching #pillBranch/#pillAb itself, matching every island's convention of
// never reaching outside its own mount target.
// Multi-line hover detail for the branch pill (see the `.branch-pill[data-tip]`
// CSS override of the shared [data-tip] rule — that base rule is single-line/
// nowrap, built for the sidebar's narrow rows; this one wraps and sits below
// the topbar instead). Spells out what the bare "↑N·↓N" glyph shorthand
// actually means (ahead/behind WHAT), which the pill itself has no room for.
function branchPillTip(cur,curB){
  if(!cur) return "Detached HEAD — not on any branch";
  const up=curB&&typeof curB==="object"?curB.upstream:null;
  if(!up) return cur+"\nNo upstream branch configured";
  const a=(curB&&typeof curB==="object"&&curB.ahead)||0, be=(curB&&typeof curB==="object"&&curB.behind)||0;
  const line2=!a&&!be ? "Up to date with "+up
    : a&&!be ? a+" commit"+(a===1?"":"s")+" ahead of "+up
    : !a&&be ? be+" commit"+(be===1?"":"s")+" behind "+up
    : a+" commit"+(a===1?"":"s")+" ahead, "+be+" commit"+(be===1?"":"s")+" behind "+up;
  return cur+"\n"+line2;
}
function updateBranchPill(cur,locals){
  const pill=$("#pillBranch"), pillAb=$("#pillAb"), pillWrap=$(".branch-pill");
  if(!pill) return;
  const curB=cur&&locals.find(b=>(typeof b==="object"?b.name:b)===cur);
  pill.textContent=cur||"detached";
  const a=(curB&&typeof curB==="object"&&curB.ahead)||0, be=(curB&&typeof curB==="object"&&curB.behind)||0;
  if(pillAb){
    if(cur&&(a||be)) pillAb.innerHTML="<b>&#8593;"+a+"</b>&#183;<b>&#8595;"+be+"</b>";
    else pillAb.textContent="";
  }
  if(pillWrap) pillWrap.setAttribute("data-tip",branchPillTip(cur,curB));
}
async function pickRepo(){
  if(!IN_TAURI||openRepoBusy) return;
  let dir=null;
  try{
    const d=window.__TAURI__.dialog;
    dir = (d&&d.open) ? await d.open({directory:true,title:"Open a Git repository"})
                      : await window.__TAURI__.core.invoke("plugin:dialog|open",{options:{directory:true,title:"Open a Git repository"}});
  }catch(e){ console.error(e); Tama.say("Dialog error — "+e); return; }
  if(dir){
    // Picking a brand-new repo via the normal picker deliberately leaves any
    // submodule-navigation chain behind — going back no longer makes sense
    // once the user's chosen something unrelated to what they navigated
    // into. But that's only committed AFTER openRepo() actually reports
    // success (same discipline as enterSubmodule/goBackToParent above):
    // clearing NAV_STACK/hiding the Back button BEFORE awaiting openRepo
    // would, on a failed pick (not a git repo, permission error, transiently
    // locked, etc.), leave the user still mid-chain with the stack already
    // wiped and no way back short of re-navigating the whole chain by hand.
    const ok=await openRepo(typeof dir==="string"?dir:(dir.path||String(dir)));
    if(ok){ NAV_STACK.length=0; updateBackToParentBtn(); }
  }
}
function bootEmpty(){
  BACKEND=null;
  CUR_REPO=null;
  // Invalidates any still-in-flight "graph-batch" stream for whatever repo
  // was just closed — unlike switching TO another repo (which naturally
  // supersedes the old generation via startGraphStream()'s own NEW
  // load_graph call), closing has no such follow-up call to piggyback on, so
  // this locally forces onGraphBatch()'s own generation check to fail for
  // any batch that arrives afterward instead of silently repopulating a
  // "closed" repo's rows into the just-reset empty state below. -1 can never
  // match a real backend-issued generation (GraphLoadState's counter starts
  // at 1 and only ever increases).
  graphGeneration=-1;
  pendingReselect=null;
  Safety.snaps=[]; Safety.updateBadge();
  if(IN_TAURI) tinvoke("unwatch_repo").catch(e=>console.error("unwatch_repo",e));
  sidebarCtrl.reset();
  G={N:0,commitLane:[],commitColor:[],isMerge:[],gapStart:[0],gapTop:[],gapBot:[],gapColor:[],refs:[],snapRows:[],snapTs:{}};
  state.selectedRow=-1; state.hoverRow=-1; state.scrollTop=state.scrollTarget=0; state.panX=state.panTarget=0;
  bisectDrawerCtrl.clearLocalMarks();
  workdirCtrl.deselect(); // no repo open -> the pinned row can't be selected either
  recomputeLayout(); positionTicks();
  detailCtrl.showEmpty();
  // Was never touched here, only correct by accident: this function used to
  // run exactly once, at cold boot, before openRepo() had ever set these away
  // from their static HTML placeholders. Now that closeRepo() (below) can
  // call it AFTER a repo was open, leaving these alone would keep showing the
  // just-closed repo's name and branch as if it were still open.
  const pick=$(".repo-pick .repo-name"); if(pick) pick.textContent="Open a repository…";
  const bp=$(".branch-pill"); if(bp) bp.style.display="none";
  dirty=true;
  Tama.set("greeting"); // cold boot AND "Close Repository" both land here — a wave either way
}
// "Close Repository" (File menu) — without this, the ONLY way back to the
// empty/default state was quitting the app outright; bootEmpty() existed
// but nothing after cold boot ever called it again. Cancels the same
// long-running, repo-tied ops openRepo() cancels before switching away, and
// clears NAV_STACK/hides "← Back to …" exactly like pickRepo() does when it
// opens something unrelated to whatever submodule chain the user was in.
async function closeRepo(){
  if(!IN_TAURI||!CUR_REPO) return;
  await bisectCtrl.cancelIfRunning();
  bootEmpty();
  NAV_STACK.length=0; updateBackToParentBtn();
}
// Opens the same Repositories dashboard modal as the empty-hero's/sidebar's
// own "Open a repository…" button (see Detail.svelte/Sidebar.svelte) rather
// than jumping straight to the native folder picker — one consistent entry
// point for "open/switch repository" everywhere it's offered in the UI,
// whether or not a repo is currently open (the dashboard's own "+ Add
// repository…" is where the native picker still lives).
$(".repo-pick").addEventListener("click", ()=>dashboardCtrl.show());
$("#backToParentBtn").addEventListener("click", goBackToParent);

// Persisted settings (Settings modal, src/islands/settings) — defaults match
// what this boot sequence used to hardcode, so an existing user with nothing
// saved yet sees no behavior change. cherryPickRecordOriginDefault itself is
// read fresh at cherry-pick time (see cherryPick() above), not seeded into
// any DOM element here — there's no longer a live per-pick checkbox to seed.
applyThemeMode(loadSettings().themeMode);
setGraphShowAllTags(loadSettings().showAllCommitTags);
$("#dangerTamaImg").src=TAMA_IMG.alarm; $("#tamaCheerImg").src=TAMA_IMG.happy;
new ResizeObserver(()=>resize()).observe(wrap);
resize();
if(IN_TAURI){ bootEmpty(); }        // real app: wait for the user to open a repo
else { loadGraph(10000); }          // plain browser (design mode): synthetic demo data
requestAnimationFrame(tick);
if(!IN_TAURI) setTimeout(()=>{Tama.event("snapshot.surfaced");Tama.say("Safety Manager armed — I snapshot before every mutation. にゃ〜",4200);},800);

/* ============================================================
   13) ⌘K COMMAND PALETTE — now a Svelte island (src/islands/cmdk).
   ============================================================ */
const cmdHint=$(".cmd-hint"); if(cmdHint) cmdHint.addEventListener("click",()=>cmdkCtrl.show());

function requestRedraw(){ dirty=true; }
export { reloadGraph, cheer, highlight, Tama, TAMA_IMG, requestRedraw,
  G, BACKEND, state, layout, view, cv, clampScroll, select, selectWorkdir, goToUncommitted, hhex, msgOf, AUTHORS,
  fakeAgo, relTime, absTime, pickRepo, closeRepo, armDanger, updateBranchPill,
  openRepo, doFetch, doPull, doPush, bandH, applyThemeMode, setGraphShowAllTags, onGraphBatch,
  // submodule navigation (see the "12a) SUBMODULE NAVIGATION STACK" section
  // above for the full design) — enterSubmodule/goBackToParent are hoisted
  // `function` declarations, so no TDZ risk (same reasoning as
  // select/openRepo above). NAV_STACK itself is already exported directly at
  // its declaration above (`export let NAV_STACK`), same as CUR_REPO — not
  // re-listed here, that would be a duplicate export.
  enterSubmodule, goBackToParent };
