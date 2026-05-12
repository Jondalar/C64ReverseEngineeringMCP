interface SafeHandlerError {
  toolName: string;
  projectRoot?: string;
  failingPhase?: string;
  inputPath?: string;
  filesWritten?: string[];
  recommendedNextAction?: string;
}

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; [key: string]: unknown };

function textContent(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

function renderErrorEnvelope(toolName: string, error: unknown, hint: SafeHandlerError = { toolName }): ToolTextResult {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? error.stack.split("\n").slice(0, 6).join("\n") : "";
  const lines: string[] = [];
  lines.push(`# Tool Error`);
  lines.push(``);
  lines.push(`Tool: ${toolName}`);
  if (hint.projectRoot) lines.push(`Project root: ${hint.projectRoot}`);
  if (hint.failingPhase) lines.push(`Failing phase: ${hint.failingPhase}`);
  if (hint.inputPath) lines.push(`Input path: ${hint.inputPath}`);
  if (hint.filesWritten && hint.filesWritten.length > 0) {
    lines.push(`Files written before failure:`);
    for (const path of hint.filesWritten) lines.push(`- ${path}`);
  }
  lines.push(``);
  lines.push(`Error: ${message}`);
  if (stack) {
    lines.push(``);
    lines.push("```");
    lines.push(stack);
    lines.push("```");
  }
  lines.push(``);
  lines.push(`Recommended next action: ${hint.recommendedNextAction ?? "Investigate the failing phase and re-run the tool with corrected inputs."}`);
  return textContent(lines.join("\n"));
}

export function safeHandler<TArgs, TResult extends { content: unknown[] }>(
  toolName: string,
  handler: (args: TArgs, extra?: unknown) => Promise<TResult>,
): (args: TArgs, extra?: unknown) => Promise<TResult | ToolTextResult> {
  return async (args: TArgs, extra?: unknown) => {
    try {
      return await handler(args, extra);
    } catch (error) {
      process.stderr.write(`[c64-re mcp] tool '${toolName}' failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return renderErrorEnvelope(toolName, error);
    }
  };
}
