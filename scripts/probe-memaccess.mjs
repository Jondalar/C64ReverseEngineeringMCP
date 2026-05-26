#!/usr/bin/env node
// scripts/probe-memaccess.mjs — smoke for the memory-access/region-liveness map.
import { MemoryAccessTracker, analyzeMemoryAccess } from "../dist/runtime/headless/debug/memory-access-map.js";
let pass=0; const fail=[]; const g=(n,ok,d)=>{ if(ok){pass++;console.log(`  PASS  ${n}${d?` (${d})`:""}`);}else{fail.push(n);console.log(`  FAIL  ${n}${d?` (${d})`:""}`);} };

console.log("Spike — memory-access map");
// 1) synthetic mock-bus classification
{
  let obs=null; const bus={ setAccessObserver:(o)=>{obs=o;} };
  const t=new MemoryAccessTracker(bus); t.attach();
  // page $20: write then read → live ; page $30: write only → dead ;
  // page $40: read only → read-only ; page $50: untouched → unused ;
  // page $60: read then write (write last, not consumed) → dead
  obs("write",0x2000,1); obs("read",0x2010,0);
  obs("write",0x3000,1); obs("write",0x3050,2);
  obs("read",0x4000,0); obs("read",0x4080,0);
  obs("read",0x6000,0); obs("write",0x6000,9);
  const m=t.finish();
  const cls=(p)=>m.pages[p].cls;
  g("write→read = live", cls(0x20)==="live", cls(0x20));
  g("write-only = dead", cls(0x30)==="dead", cls(0x30));
  g("read-only", cls(0x40)==="read-only", cls(0x40));
  g("untouched = unused", cls(0x50)==="unused", cls(0x50));
  g("read-then-write(last) = dead", cls(0x60)==="dead", cls(0x60));
  g("regions are contiguous runs", m.regions.length>0 && m.regions[0].start===0);
}
// 2) real session: to READY, then analyze a runFor window
{
  const { startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
  const { session, sessionId } = startIntegratedSession({ mode:"true-drive", useMicrocodedCpu:true, vicRenderer:"literal-port" });
  try{
    session.resetCold("pal-default"); session.runFor(2_000_000,{cycleBudget:2_000_000}); // to READY
    const map=analyzeMemoryAccess(session, ()=>session.runFor(500_000,{cycleBudget:500_000}));
    const pg=(a)=>map.pages[(a>>8)&0xff];
    let kReads=0; for(let p=0xe0;p<=0xff;p++) kReads+=map.pages[p].reads;
    g("KERNAL $E000-$FFFF executed (reads>0)", kReads>0, `kernal reads=${kReads}`);
    g("zero-page touched", pg(0x0000).reads+pg(0x0000).writes>0);
    g("some region classified", map.regions.length>=2, `${map.regions.length} regions`);
    const dead=map.regions.filter(r=>r.cls==="dead").length, unused=map.regions.filter(r=>r.cls==="unused").length;
    console.log(`        live/ro/dead/unused regions present; dead=${dead} unused=${unused}`);
  } finally { stopIntegratedSession(sessionId); }
}
console.log("---");
if(fail.length===0){console.log(`GREEN memaccess: ${pass} checks pass.`);process.exit(0);}
console.log(`RED: ${pass} pass, ${fail.length} fail.`);process.exit(1);
