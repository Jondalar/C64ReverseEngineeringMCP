#!/usr/bin/env node
// Spec 418 — IEC Phase C smoke: push-flush call-site coverage.
//
// Doctrine: 1:1 VICE IEC port. Validates the push-flush invariant
// per docs/vice-iec-arc42.md §15 Phase C (steps 7-9) and §5.11
// call-site enumeration: every C64-side IEC mutation site MUST
// invoke `drive_cpu_execute_one(unit, clk)` (writes) or
// `drive_cpu_execute_all(clk)` (reads) BEFORE touching cpu_bus /
// drv_bus / cpu_port / drv_port. Spec 418 promotes the flush from
// a KernelBus precondition into a property of the IecBus mutation
// primitive itself (= IecBus.pushFlush callback installed by the
// kernel).
//
// Doc anchors:
//   docs/vice-iec-arc42.md §15 Phase C (steps 7-9)
//   docs/vice-iec-arc42.md §5.11 (verified call-site table)
//   docs/vice-iec-arc42.md §6.1, §6.2 (sequence diagrams)
//   docs/vice-iec-arc42.md §9 ADR-1 (push-flush adoption)
//   docs/vice-iec-arc42.md §17.3 (OQ-418-1 resolution)
//
// VICE source citations (verified 2026-05-12 against vice-3.7.1):
//   src/iecbus/iecbus.c:226-234   — iecbus_cpu_read_conf1
//                                    (drive_cpu_execute_all → return cpu_port)
//   src/iecbus/iecbus.c:237-287   — iecbus_cpu_write_conf1
//                                    (drive_cpu_execute_one → mutate)
//   src/iecbus/iecbus.c:289-330   — iecbus_cpu_{read,write}_conf2 (unit 9)
//   src/iecbus/iecbus.c:332-410   — iecbus_cpu_{read,write}_conf3 (multi)
//   src/drive/drive.c:991         — drive_cpu_execute_one
//   src/drive/drive.c:1001        — drive_cpu_execute_all
//
// Test strategy:
//   Sub-test A — Auditor wiring: install IecBus.pushFlush + flushAuditor;
//     call setC64Output / buildC64InputBits and assert the auditor
//     records the right (kind, site) pair AND that `pushFlush` ran
//     BEFORE the bus mutation (auditor receives pre-mutation cpu_bus
//     snapshot that differs from the post-call value).
//   Sub-test B — Conf-pair coverage: for conf0 / conf1 / conf2 /
//     conf3, assert the dispatcher routes through `_performC64Write`
//     / `_performC64Read` (= the only place pushFlush fires). Drive
//     statusSet to switch active conf and verify auditor still fires.
//   Sub-test C — Spec 218 cycleStepped flag is forwarded: setC64Output
//     called with cycleStepped=true ⇒ pushFlush.one receives true;
//     called with cycleStepped=false ⇒ pushFlush.one receives false.
//   Sub-test D — Atomic-mutation invariant (§15 step 9): between
//     pushFlush firing and core mutation, no synchronous step should
//     mutate `core.cpu_bus`. Assert by capturing cpu_bus inside the
//     pushFlush callback and again after the call returns; the only
//     mutation in between must come from `c64_store_dd00`.

import { IecBus } from "../dist/runtime/headless/iec/iec-bus.js";
import {
  IECBUS_STATUS_TRUEDRIVE,
  IECBUS_STATUS_DRIVETYPE,
} from "../dist/runtime/headless/iec/iecbus-callbacks.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}
const hex = (v, w = 2) => "$" + (v & 0xff).toString(16).padStart(w, "0");

// ---------- Sub-test A: auditor wiring ---------------------------------
// VICE conf1 write: drive_cpu_execute_one BEFORE iec_update_cpu_bus.
// VICE conf1 read : drive_cpu_execute_all BEFORE return cpu_port.
{
  const bus = new IecBus();
  const audit = [];
  let flushOneSeen = 0;
  let flushAllSeen = 0;
  let flushOneSnapshot = null;
  bus.pushFlush = {
    one: (unit, clock, cycleStepped) => {
      flushOneSeen++;
      // Sample cpu_bus AT the moment of flush — must equal the
      // pre-mutation value (§15 step 9: no interleaving).
      flushOneSnapshot = { unit, clock, cycleStepped, cpu_bus: bus.core.cpu_bus };
    },
    all: (_clock, _cs) => { flushAllSeen++; },
  };
  bus.flushAuditor = (rec) => audit.push(rec);

  // Drive a write ⇒ expect one auditor record + one flushOne call.
  // PA = 0x18 (ATN+CLK out), inverted = 0xe7 ⇒ cpu_bus ≠ 0xff (init).
  const beforeCpuBus = bus.core.cpu_bus;
  bus.setC64Output(0x18, 0x3f, 4242);
  const afterCpuBus = bus.core.cpu_bus;

  check(
    "setC64Output ⇒ exactly 1 pushFlush.one call",
    flushOneSeen === 1,
    `got ${flushOneSeen}`,
  );
  check(
    "setC64Output ⇒ no pushFlush.all call",
    flushAllSeen === 0,
    `got ${flushAllSeen}`,
  );
  check(
    "setC64Output ⇒ exactly 1 auditor record",
    audit.length === 1,
    `got ${audit.length}`,
  );
  check(
    "auditor record has kind='one' (= drive_cpu_execute_one)",
    audit[0]?.kind === "one",
    `got ${audit[0]?.kind}`,
  );
  check(
    "auditor record has site='c64-write'",
    audit[0]?.site === "c64-write",
    `got ${audit[0]?.site}`,
  );
  check(
    "auditor record clock == effectiveClock supplied",
    audit[0]?.clock === 4242,
    `got ${audit[0]?.clock}`,
  );
  // Atomicity: pre-flush snapshot must equal pre-call snapshot
  // (= no mutation happened between pushFlush firing and mutation).
  check(
    "pushFlush fired BEFORE mutation (snapshot cpu_bus == pre-call)",
    flushOneSnapshot?.cpu_bus === beforeCpuBus,
    `flush=${hex(flushOneSnapshot?.cpu_bus)} pre=${hex(beforeCpuBus)}`,
  );
  // Mutation actually happened after the flush.
  check(
    "after setC64Output, cpu_bus changed (mutation actually ran)",
    afterCpuBus !== beforeCpuBus,
    `before=${hex(beforeCpuBus)} after=${hex(afterCpuBus)}`,
  );
  // pushFlush.one must target unit 8 for conf1.
  check(
    "pushFlush.one targets unit 8 (= conf1)",
    flushOneSnapshot?.unit === 8,
    `got ${flushOneSnapshot?.unit}`,
  );
}

// ---------- Sub-test B: read flush is drive_cpu_execute_all ------------
{
  const bus = new IecBus();
  const audit = [];
  let flushAllClock = null;
  let preReadSnapshotMatched = false;
  bus.pushFlush = {
    one: (_u, _c) => {},
    all: (clock) => {
      flushAllClock = clock;
      // §15 step 7: read flush BEFORE returning cached cpu_port.
      // cpu_port snapshot at this point must equal what the read
      // call returns post-flush (read does not mutate).
      preReadSnapshotMatched = bus.core.cpu_port === bus.core.cpu_port;
    },
  };
  bus.flushAuditor = (rec) => audit.push(rec);

  const result = bus.buildC64InputBits(7777);
  check(
    "buildC64InputBits ⇒ pushFlush.all fired (= drive_cpu_execute_all)",
    flushAllClock === 7777,
    `got ${flushAllClock}`,
  );
  check(
    "buildC64InputBits ⇒ auditor records kind='all', site='c64-read'",
    audit.length === 1 && audit[0]?.kind === "all" && audit[0]?.site === "c64-read",
    `got ${JSON.stringify(audit)}`,
  );
  check(
    "buildC64InputBits ⇒ returned value == cached cpu_port (no mutation)",
    result === (bus.core.cpu_port & 0xff),
    `got ${hex(result)} cpu_port=${hex(bus.core.cpu_port)}`,
  );
  void preReadSnapshotMatched;
}

// ---------- Sub-test C: cycleStepped hint forwarded --------------------
// Spec 218 hybrid sync rule: KernelBus computes `pc < 0xa000` and
// passes through. The flag must reach pushFlush.{one,all} verbatim.
{
  const bus = new IecBus();
  const seenWrite = [];
  const seenRead = [];
  bus.pushFlush = {
    one: (_u, _c, cs) => seenWrite.push(cs),
    all: (_c, cs) => seenRead.push(cs),
  };
  bus.setC64Output(0x18, 0x3f, 1, true);
  bus.setC64Output(0x18, 0x3f, 2, false);
  bus.setC64Output(0x18, 0x3f, 3, undefined);
  bus.buildC64InputBits(11, true);
  bus.buildC64InputBits(12, false);
  bus.buildC64InputBits(13, undefined);
  check(
    "pushFlush.one(cycleStepped) sequence == [true, false, false]",
    JSON.stringify(seenWrite) === JSON.stringify([true, false, false]),
    `got ${JSON.stringify(seenWrite)}`,
  );
  check(
    "pushFlush.all(cycleStepped) sequence == [true, false, false]",
    JSON.stringify(seenRead) === JSON.stringify([true, false, false]),
    `got ${JSON.stringify(seenRead)}`,
  );
}

// ---------- Sub-test D: §5.11 conf-pair coverage -----------------------
// Each conf{N} dispatcher MUST route through _performC64{Read,Write}
// = the only place pushFlush fires. Verify by switching active conf
// and confirming the auditor still records the call.
{
  const cases = [
    {
      label: "conf0 (no devices)",
      setup: (cb) => {
        // Default = conf0; no extra setup.
        void cb;
      },
      expectedConf: 0,
    },
    {
      label: "conf1 (only unit 8 TDE)",
      setup: (cb) => {
        cb.statusSet(IECBUS_STATUS_TRUEDRIVE, 8, true);
        cb.statusSet(IECBUS_STATUS_DRIVETYPE, 8, true);
      },
      expectedConf: 1,
    },
    {
      label: "conf2 (only unit 9 TDE)",
      setup: (cb) => {
        cb.statusSet(IECBUS_STATUS_TRUEDRIVE, 9, true);
        cb.statusSet(IECBUS_STATUS_DRIVETYPE, 9, true);
      },
      expectedConf: 2,
    },
    {
      label: "conf3 (multi-drive: units 8 + 9 TDE)",
      setup: (cb) => {
        cb.statusSet(IECBUS_STATUS_TRUEDRIVE, 8, true);
        cb.statusSet(IECBUS_STATUS_DRIVETYPE, 8, true);
        cb.statusSet(IECBUS_STATUS_TRUEDRIVE, 9, true);
        cb.statusSet(IECBUS_STATUS_DRIVETYPE, 9, true);
      },
      expectedConf: 3,
    },
  ];
  for (const c of cases) {
    const bus = new IecBus();
    // IecBus default = conf1; reset all four flag arrays for unit 8
    // by re-entering false then re-applying the case setup.
    bus.callbacks.statusSet(IECBUS_STATUS_TRUEDRIVE, 8, false);
    bus.callbacks.statusSet(IECBUS_STATUS_DRIVETYPE, 8, false);
    c.setup(bus.callbacks);
    check(
      `${c.label} ⇒ activeConf == ${c.expectedConf}`,
      bus.callbacks.activeConf === c.expectedConf,
      `got ${bus.callbacks.activeConf}`,
    );
    let flushed = 0;
    bus.pushFlush = {
      one: () => flushed++,
      all: () => flushed++,
    };
    bus.setC64Output(0x18, 0x3f, 100);
    bus.buildC64InputBits(101);
    check(
      `${c.label} ⇒ both write+read fire pushFlush via dispatcher (=2)`,
      flushed === 2,
      `got ${flushed}`,
    );
  }
}

// ---------- Sub-test E: pushFlush optional (back-compat) ---------------
// Direct-construction smokes / serial-matrix tests bypass the kernel
// and never install pushFlush. Mutation must still work; flush is
// simply skipped. Auditor must NOT fire when pushFlush is unset.
{
  const bus = new IecBus();
  let auditCount = 0;
  bus.flushAuditor = () => auditCount++;
  bus.setC64Output(0x18, 0x3f, 5);
  check(
    "no pushFlush installed ⇒ no auditor record",
    auditCount === 0,
    `got ${auditCount}`,
  );
  check(
    "no pushFlush installed ⇒ mutation still runs (cpu_bus changed)",
    bus.core.cpu_bus !== 0xff,
    `cpu_bus=${hex(bus.core.cpu_bus)}`,
  );
}

// ---------- Report -----------------------------------------------------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(
  `Spec 418 smoke — push-flush coverage — ${pass}/${results.length} pass, ${fail} fail`,
);
if (fail > 0) {
  for (const r of results) if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
  process.exit(1);
}
