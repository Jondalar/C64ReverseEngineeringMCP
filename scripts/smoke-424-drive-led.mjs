#!/usr/bin/env node
// Spec 424 — Drive LED VICE 1:1 PWM model smoke.
//
// Verifies DriveLedMonitor mirrors VICE drive.c:870-931:
//   - LED off (PB3=0) → PWM 0
//   - LED steady on (PB3=1 long) → PWM 1000 (= MAX)
//   - LED rapid toggle → PWM medium (= averaged brightness, sqrt curve)
//   - reset clears state

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);

const checks = [];
function check(name, ok, msg = "") {
  checks.push({ name, ok, msg });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${msg ? " — " + msg : ""}`);
}

const { session } = startIntegratedSession({ sessionId: "smoke-424", videoStandard: "pal" });
const drv = session.drive;
const led = drv.bus.ledMonitor;

// Baseline sample: zero state, reset accumulator at base clock.
let clk = drv.cpu.cycles;
led.sampleAndReset(clk);

// Steady ON for 100k cycles
led.noteTransition(true, clk);
clk += 100_000;
{
  const s = led.sampleAndReset(clk);
  check("steady on pwm=1000", s.pwm === 1000, `pwm=${s.pwm}`);
  check("steady on on=true", s.on === true);
}

// 50% duty cycle: 10 on/off pairs over 100k cycles
for (let i = 0; i < 10; i++) {
  clk += 5_000;
  led.noteTransition(false, clk);
  clk += 5_000;
  led.noteTransition(true, clk);
}
{
  const s = led.sampleAndReset(clk);
  // Approx 50% duty → raw 500 → sqrt(0.5)*1000 ≈ 707
  check("50% duty pwm~707", s.pwm >= 600 && s.pwm <= 800, `pwm=${s.pwm}`);
}

// Idle (off) for 100k
led.noteTransition(false, clk);
clk += 100_000;
{
  const s = led.sampleAndReset(clk);
  check("idle pwm=0", s.pwm === 0, `pwm=${s.pwm}`);
  check("idle on=false", s.on === false);
}

// Reset
led.reset();
{
  const s = led.sampleAndReset(clk + 1);
  check("post-reset pwm=0", s.pwm === 0, `pwm=${s.pwm}`);
  check("post-reset on=false", s.on === false);
}

const fails = checks.filter(c => !c.ok).length;
console.log(`---\nsummary: ${checks.length - fails}/${checks.length} pass, ${fails} fail`);
process.exit(fails > 0 ? 1 : 0);
