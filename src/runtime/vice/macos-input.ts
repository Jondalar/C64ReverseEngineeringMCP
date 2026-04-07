import { execFile } from "node:child_process";

const MAC_KEY_CODE_BY_CHAR = new Map<string, number>([
  ["a", 0],
  ["s", 1],
  ["d", 2],
  ["f", 3],
  ["h", 4],
  ["g", 5],
  ["z", 6],
  ["x", 7],
  ["c", 8],
  ["v", 9],
  ["b", 11],
  ["q", 12],
  ["w", 13],
  ["e", 14],
  ["r", 15],
  ["y", 16],
  ["t", 17],
  ["1", 18],
  ["2", 19],
  ["3", 20],
  ["4", 21],
  ["6", 22],
  ["5", 23],
  ["=", 24],
  ["9", 25],
  ["7", 26],
  ["-", 27],
  ["8", 28],
  ["0", 29],
  ["]", 30],
  ["o", 31],
  ["u", 32],
  ["[", 33],
  ["i", 34],
  ["p", 35],
  ["l", 37],
  ["j", 38],
  ["'", 39],
  ["k", 40],
  [";", 41],
  ["\\", 42],
  [",", 43],
  ["/", 44],
  ["n", 45],
  ["m", 46],
  [".", 47],
  ["`", 50],
  [" ", 49],
]);

export async function sendMacOsKeyCodesToProcess(
  pid: number,
  keyCodes: number[],
  durationMs: number,
): Promise<void> {
  const uniqueCodes = Array.from(new Set(keyCodes));
  if (uniqueCodes.length === 1 && isFunctionKeyCode(uniqueCodes[0])) {
    await execAppleScript(buildJxaActivationScript(pid), "JavaScript");
    const script = buildAppleScriptFunctionKeyScript(pid, uniqueCodes[0]);
    await execAppleScript(script, "AppleScript");
    return;
  }

  const script = buildJxaKeyboardScript(pid, uniqueCodes, durationMs);
  await execAppleScript(script, "JavaScript");
}

export function keyCodeForViceCharacter(character: string): number {
  const normalized = character.toLowerCase();
  const code = MAC_KEY_CODE_BY_CHAR.get(normalized);
  if (code === undefined) {
    throw new Error(`Unsupported joystick key character for macOS injection: ${JSON.stringify(character)}`);
  }
  return code;
}

function buildJxaKeyboardScript(pid: number, keyCodes: number[], durationMs: number): string {
  const serializedKeyCodes = JSON.stringify(keyCodes);
  return `
ObjC.import("AppKit");
ObjC.import("ApplicationServices");

function postKey(code, isDown) {
  const event = $.CGEventCreateKeyboardEvent(null, code, isDown);
  $.CGEventPost($.kCGHIDEventTap, event);
}

const pid = ${pid};
const keyCodes = ${serializedKeyCodes};
const durationSeconds = ${Math.max(0, durationMs) / 1000};

${buildActivationSnippet()}

for (const code of keyCodes) {
  postKey(code, true);
}

delay(durationSeconds);

for (const code of keyCodes.slice().reverse()) {
  postKey(code, false);
}
`;
}

function buildJxaActivationScript(pid: number): string {
  return `
ObjC.import("AppKit");

const pid = ${pid};
${buildActivationSnippet()}
`;
}

function buildAppleScriptFunctionKeyScript(_pid: number, keyCode: number): string {
  return `
tell application "System Events"
  key code ${keyCode}
end tell
`;
}

function buildActivationSnippet(): string {
  return `
try {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (app) {
    app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
    delay(0.05);
  }
} catch (error) {
  // Fall back without an activation hint.
}
`;
}

function isFunctionKeyCode(keyCode: number): boolean {
  return keyCode >= 122 && keyCode <= 135;
}

function execAppleScript(script: string, language: "AppleScript" | "JavaScript"): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-l", language, "-e", script], (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve();
    });
  });
}
