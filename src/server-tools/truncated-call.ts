// A required parameter that arrives missing after a long free-text one.
//
// An autonomous run hit this twice in one session:
//
//     Invalid arguments ... path: ["evidence"] ... Required
//
// with `evidence` written out in full in the call it had just made, and sending
// the identical content again worked. The message was the MCP SDK's own schema
// validation, which runs before the handler and says only which key the JSON did
// not contain.
//
// It was measured before it was fixed. Nothing in this server drops an argument:
// over the real stdio transport `slot_record` stores a 4 MiB `answer` together
// with its `evidence`, and every size between 1 KiB and that is fine. The
// argument object that reached the door genuinely had no `evidence` in it — the
// tool call was cut short as the CALLER wrote it, which is exactly why a retry
// of the same content succeeds. That is not something this process can prevent.
//
// What it can do is stop answering with a schema dump. The door checks the
// required field itself and says what the shape of the failure means, with the
// one remedy that is actually within the caller's control: a truncated object
// loses what was written LAST, so the short parameter goes first.
//
// The fields are therefore declared optional in the tool schema and required
// here. That is a deliberate trade: the schema loses one `required` entry, the
// description says REQUIRED in words, and the refusal gains a cause.

export interface ProseField {
  name: string;
  value: string | undefined;
}

/** Roughly how long a free-text argument has to be before truncation is the likely story. */
export const PROSE_TRUNCATION_SUSPICION = 600;

/**
 * The refusal text for a required parameter that did not arrive.
 *
 * `prose` names the long free-text parameters that DID arrive; when one of them
 * is long enough for the truncation story to hold, the message tells it.
 */
export function missingRequiredText(opts: {
  tool: string;
  missing: string;
  what: string;
  prose: ProseField[];
}): string {
  const longest = opts.prose
    .filter((p): p is { name: string; value: string } => typeof p.value === "string")
    .sort((a, b) => b.value.length - a.value.length)[0];
  const lines: string[] = [
    `# ${opts.tool} refused — ${opts.missing} did not arrive.`,
    "",
    `${opts.missing}: ${opts.what}`,
  ];
  if (longest && longest.value.length >= PROSE_TRUNCATION_SUSPICION) {
    lines.push(
      "",
      `\`${longest.name}\` came through at ${longest.value.length} characters and \`${opts.missing}\` did not, `
      + `which is the shape of a tool call that was cut short as it was written. Nothing here imposes a limit: `
      + `this door takes a multi-megabyte \`${longest.name}\` over the same transport and stores it whole, and a `
      + `call carrying both fields is never truncated on the way in. What is missing was already missing from the `
      + `JSON that arrived — which is why re-sending the identical content usually works.`,
      "",
      "Two ways past it:",
      `  • send it again with \`${opts.missing}\` written BEFORE \`${longest.name}\` — what gets cut is what comes last;`,
      `  • or shorten \`${longest.name}\`. Its full length is kept either way, so a long one is allowed; it is simply the part most likely to be lost.`,
    );
  }
  lines.push("", "Nothing was written.");
  return lines.join("\n");
}

/**
 * The refusal a caller gets when a CAPPED field arrives over its cap.
 *
 * Held to the same standard as `missingRequiredText` above, for the same reason. A
 * `.max(n)` in the tool's schema cannot reach that standard: it fires in the SDK
 * before the handler runs, so the answer is the validation dump
 *
 *     Invalid arguments ... title: String must contain at most 120 character(s)
 *
 * and it arrives AFTER the whole call has been composed — which, on a door whose
 * other argument is a multi-paragraph answer, is the expensive moment to find out.
 * The dump names neither the overage, nor that the long field beside it is kept
 * whole, nor that omitting the capped one produces a usable value by itself. All
 * three are things the caller would act on, and all three are known here.
 *
 * So the cap comes out of the schema and is checked in the handler, exactly as the
 * required fields above are. The schema loses one `maxLength`; the description says
 * the number in words, and the refusal gains a remedy.
 */
export function capExceededText(opts: {
  tool: string;
  field: string;
  limit: number;
  value: string;
  /** What the field is FOR — why this one is the capped one. */
  role: string;
  /** What the door would use for `field` if it were left out. */
  suggestion: string;
  /** The uncapped field beside it, and where its full text goes. */
  uncapped?: { name: string; where: string };
}): string {
  const over = opts.value.length - opts.limit;
  const lines: string[] = [
    `# ${opts.tool} refused — \`${opts.field}\` is ${opts.value.length} characters and the cap is ${opts.limit}.`,
    "",
    opts.role,
  ];
  if (opts.uncapped) {
    lines.push(
      "",
      `\`${opts.uncapped.name}\` is NOT capped — ${opts.uncapped.where}, however long it runs. `
      + `Nothing about this cap asks you to shorten what you established.`,
    );
  }
  lines.push(
    "",
    "Three ways past it, and none of them needs the call composed again:",
    `  • leave \`${opts.field}\` out — the door writes one by itself;`,
    `  • or send this one, which is what leaving it out of THIS call would have produced:`,
    `      "${opts.suggestion}"`,
    `  • or write your own at ${opts.limit} characters or fewer — you are ${over} over.`,
    "",
    "Nothing was written.",
  );
  return lines.join("\n");
}
