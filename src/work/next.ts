// Spec 917 D1 - once a project has a plan, the next step comes from the plan: which card waits for the human, which came
// back NOT KEPT, which package needs a card, which cards are out with workers, which package can close.

import { listCards, listPackages } from "./store.js";

export interface PlanStep {
  stepId: "plan-gate" | "plan-replan" | "plan-next-card" | "plan-await-workers" | "plan-close";
  why: string;
  args: Record<string, unknown>;
  /** Set when the step is a question for the human (the human gate). */
  humanQuestion?: string;
}

export function hasPlan(projectRoot: string): boolean {
  try { return listPackages(projectRoot).length > 0; } catch { return false; }
}

/** The plan's next step, or undefined when there is no plan or every package is closed (then the ordinary ladder runs). */
export function planNextStep(projectRoot: string): PlanStep | undefined {
  let pkgs, cards;
  try { pkgs = listPackages(projectRoot); cards = listCards(projectRoot); } catch { return undefined; }
  if (pkgs.length === 0) return undefined;

  const waiting = cards.find((c) => c.state === "waiting");
  if (waiting) {
    const human = waiting.doneWhen.filter((d) => d.kind === "human").map((d) => `[human] ${d.text}`);
    const q = `Card ${waiting.name} (${waiting.title}) waits for the human gate: its machine lines hold. Decide: ${human.join(" | ") || "(no human line recorded)"}. Say kept or not kept, who you are and why.`;
    return {
      stepId: "plan-gate",
      why: `${q} The architect records it with card(action="judge", card="${waiting.name}", kept, by, why).`,
      args: { action: "judge", card: waiting.name },
      humanQuestion: q,
    };
  }

  const back = cards.find((c) => c.state === "not_kept" || c.state === "stopped");
  if (back) {
    return {
      stepId: "plan-replan",
      why: `Card ${back.name} (${back.title}) came back ${back.state === "stopped" ? "STOPPED" : "NOT KEPT"}. Read it with card(action="show") - the verdict names the failing check - then re-plan: issue a corrected card.`,
      args: { action: "show", card: back.name },
    };
  }

  const open = pkgs.find((p) => p.state === "open");
  if (!open) return undefined;
  const mine = cards.filter((c) => c.package === open.name);
  if (mine.length === 0) {
    return {
      stepId: "plan-next-card",
      why: `Package ${open.name} (${open.title}) is open and has no card. The architect writes the next card from its done-when with card(action="issue", package="${open.name}", ...).`,
      args: { action: "issue", package: open.name },
    };
  }
  const out = mine.filter((c) => c.state === "issued");
  if (out.length > 0) {
    return {
      stepId: "plan-await-workers",
      why: `Card(s) issued and not yet reported: ${out.map((c) => c.name).join(", ")}. They are out with workers (briefing: c64re_worker_card). A worker's report arrives through agent_record_step(card, result).`,
      args: { action: "show", card: out[0]!.name },
    };
  }
  return {
    stepId: "plan-close",
    why: `Every card of package ${open.name} (${open.title}) is KEPT but the package is open. Close it with plan(action="close", package="${open.name}") - or issue another card if the package needs more.`,
    args: { action: "close", package: open.name },
  };
}
