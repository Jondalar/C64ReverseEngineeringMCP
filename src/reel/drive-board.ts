// C64RE #33 — the drive a private machine needs is the one its medium asks for.
//
// A daemon starts with a 1541 at drive 8, and a D81 does not fit one: the runtime refuses
// it with "a D81 does not fit a 1541: D81 media go into a 1581". That sentence is the
// runtime's own content identification, so it is what decides here — C64RE does not keep
// a second opinion about what a medium is. On a private machine (the sandbox, the reel),
// whose drive nobody else is using, the runner fits the board the refusal names and opens
// the medium again. The SHARED session never goes through this: changing a board switches
// the drive off and on, and that is not a runner's call to make on the human's machine.

export type DriveBoard = "1541" | "1581";
export const DRIVE_BOARDS: readonly DriveBoard[] = ["1541", "1581"];

type Call = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

/** The runtime's refusal of a medium the drive cannot hold — the board it names. */
const NEEDS_BOARD = /media go into a (1541|1581)\b/i;

/**
 * Make drive 8 a `board`. The runtime refuses a type change on a powered drive, so it is
 * switched off around the change; a medium that does not fit the new board is written
 * back to its file and ejected by the runtime itself.
 */
export async function setDriveBoard(call: Call, board: DriveBoard): Promise<void> {
  await call("session/drive_power", { unit: 8, on: false });
  await call("session/drive_type", { unit: 8, type: board });
  await call("session/drive_power", { unit: 8, on: true });
}

/**
 * Open a medium; when the runtime answers that it goes into the other board, fit that
 * board and open it once more. Any other refusal is the caller's, unchanged.
 */
export async function openFittingDrive<T>(call: Call, open: () => Promise<T>, log: string[]): Promise<T> {
  try {
    return await open();
  } catch (e) {
    const m = NEEDS_BOARD.exec(e instanceof Error ? e.message : String(e));
    if (!m) throw e;
    const board = m[1] as DriveBoard;
    await setDriveBoard(call, board);
    log.push(`drive 8 is now a ${board}: the medium goes into one`);
    return await open();
  }
}
