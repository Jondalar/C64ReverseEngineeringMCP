// What a tool says when the files landed and the bookkeeping did not.
//
// The worst thing a parallel RE run turned up was not the crash. It was a call
// that printed `rebuild verified byte-identical` and then, at the bottom of the
// same answer, `Knowledge registration skipped: ENOENT…`. The reader takes the
// first line and moves on; the artifact was never registered, and nothing in
// the result says the work did not land. "Skipped" is the wrong word for it
// too — skipping is a decision, and this was a failure.
//
// So the message says what did not happen, what that costs, and how to repair
// it, and the doors that own their own output put it at the TOP of the answer
// rather than after the success.

/** The banner a failed knowledge registration gets. Multi-line on purpose. */
export function registrationFailureMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return [
    `⚠ NOT REGISTERED — the project store did not take this run: ${reason}`,
    `  The files were written. Nothing in the project knows they exist, so they will not`,
    `  appear in list_artifacts, in any view, or to the next session that onboards, and`,
    `  anything derived from them will look unbacked.`,
    `  Run project_inventory_sync to register what is on disk, then repeat this step.`,
  ].join("\n");
}

/** True when a registration result is one of those failures rather than a success. */
export function registrationFailed(result: { failed?: boolean } | undefined): boolean {
  return result?.failed === true;
}
