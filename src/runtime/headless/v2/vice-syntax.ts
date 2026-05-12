// Spec 241 — VICE expression string → JS callback compiler.
//
// Handles VICE monitor conditional expression syntax:
//   a, x, y, sp, pc        — CPU registers (lower case)
//   @addr                  — memory dereference (byte at addr)
//   &, |, ^                — bitwise binary ops
//   +, -, *, /             — arithmetic
//   ==, !=, <, >, <=, >=  — comparison
//   &&, ||                 — logical
//   ()                     — grouping
//   0x / $                 — hex literals
//   decimal literals
//
// Compiled via recursive-descent to a safe JS closure over a
// BreakpointContext. No eval(); runs at parse time → fast at hit time.

import type { BreakpointContext } from "./breakpoints.js";

// ---- Tokeniser ----

type TokKind =
  | "ident" | "number"
  | "at"          // @
  | "lparen" | "rparen"
  | "plus" | "minus" | "star" | "slash"
  | "amp" | "pipe" | "caret"
  | "and" | "or"
  | "eq" | "neq" | "lt" | "lte" | "gt" | "gte"
  | "eof";

interface Token {
  kind: TokKind;
  value?: number | string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }

    // Two-char operators first.
    const two = src.slice(i, i + 2);
    if (two === "==") { tokens.push({ kind: "eq" }); i += 2; continue; }
    if (two === "!=") { tokens.push({ kind: "neq" }); i += 2; continue; }
    if (two === "<=") { tokens.push({ kind: "lte" }); i += 2; continue; }
    if (two === ">=") { tokens.push({ kind: "gte" }); i += 2; continue; }
    if (two === "&&") { tokens.push({ kind: "and" }); i += 2; continue; }
    if (two === "||") { tokens.push({ kind: "or" }); i += 2; continue; }

    if (ch === "<") { tokens.push({ kind: "lt" }); i++; continue; }
    if (ch === ">") { tokens.push({ kind: "gt" }); i++; continue; }
    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    if (ch === "+") { tokens.push({ kind: "plus" }); i++; continue; }
    if (ch === "-") { tokens.push({ kind: "minus" }); i++; continue; }
    if (ch === "*") { tokens.push({ kind: "star" }); i++; continue; }
    if (ch === "/") { tokens.push({ kind: "slash" }); i++; continue; }
    if (ch === "&") { tokens.push({ kind: "amp" }); i++; continue; }
    if (ch === "|") { tokens.push({ kind: "pipe" }); i++; continue; }
    if (ch === "^") { tokens.push({ kind: "caret" }); i++; continue; }
    if (ch === "@") { tokens.push({ kind: "at" }); i++; continue; }

    // VICE hex literal: $xxxx
    if (ch === "$") {
      let j = i + 1;
      while (j < src.length && /[0-9a-fA-F]/.test(src[j]!)) j++;
      const hex = src.slice(i + 1, j);
      if (!hex) throw new Error(`Invalid hex literal at position ${i}`);
      tokens.push({ kind: "number", value: parseInt(hex, 16) });
      i = j;
      continue;
    }

    // Standard hex: 0x / 0X
    if (ch === "0" && i + 1 < src.length && (src[i + 1] === "x" || src[i + 1] === "X")) {
      let j = i + 2;
      while (j < src.length && /[0-9a-fA-F]/.test(src[j]!)) j++;
      tokens.push({ kind: "number", value: parseInt(src.slice(i + 2, j), 16) });
      i = j;
      continue;
    }

    // Decimal
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      tokens.push({ kind: "number", value: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }

    // Identifier (registers: a, x, y, sp, pc)
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j]!)) j++;
      tokens.push({ kind: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at position ${i} in expression: ${src}`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

// ---- AST node types ----

type Expr =
  | { kind: "number"; value: number }
  | { kind: "register"; reg: string }
  | { kind: "mem_deref"; addr: Expr }
  | { kind: "binop"; op: string; left: Expr; right: Expr }
  | { kind: "unary"; op: string; operand: Expr };

// ---- Recursive-descent parser ----

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(): Token { return this.tokens[this.pos]!; }
  consume(): Token { return this.tokens[this.pos++]!; }
  expect(kind: TokKind): Token {
    const t = this.consume();
    if (t.kind !== kind) throw new Error(`Expected ${kind}, got ${t.kind}`);
    return t;
  }

  parse(): Expr { return this.parseOr(); }

  parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek().kind === "or") {
      this.consume();
      left = { kind: "binop", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd(): Expr {
    let left = this.parseBitOr();
    while (this.peek().kind === "and") {
      this.consume();
      left = { kind: "binop", op: "&&", left, right: this.parseBitOr() };
    }
    return left;
  }

  parseBitOr(): Expr {
    let left = this.parseBitXor();
    while (this.peek().kind === "pipe") {
      this.consume();
      left = { kind: "binop", op: "|", left, right: this.parseBitXor() };
    }
    return left;
  }

  parseBitXor(): Expr {
    let left = this.parseBitAnd();
    while (this.peek().kind === "caret") {
      this.consume();
      left = { kind: "binop", op: "^", left, right: this.parseBitAnd() };
    }
    return left;
  }

  parseBitAnd(): Expr {
    let left = this.parseComparison();
    while (this.peek().kind === "amp") {
      this.consume();
      left = { kind: "binop", op: "&", left, right: this.parseComparison() };
    }
    return left;
  }

  parseComparison(): Expr {
    let left = this.parseAddSub();
    const cmpOps: Record<TokKind, string> = {
      eq: "===", neq: "!==", lt: "<", lte: "<=", gt: ">", gte: ">=",
    } as Record<TokKind, string>;
    while (this.peek().kind in cmpOps) {
      const op = cmpOps[this.consume().kind as TokKind];
      left = { kind: "binop", op: op!, left, right: this.parseAddSub() };
    }
    return left;
  }

  parseAddSub(): Expr {
    let left = this.parseMulDiv();
    while (this.peek().kind === "plus" || this.peek().kind === "minus") {
      const op = this.consume().kind === "plus" ? "+" : "-";
      left = { kind: "binop", op, left, right: this.parseMulDiv() };
    }
    return left;
  }

  parseMulDiv(): Expr {
    let left = this.parseUnary();
    while (this.peek().kind === "star" || this.peek().kind === "slash") {
      const op = this.consume().kind === "star" ? "*" : "/";
      left = { kind: "binop", op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary(): Expr {
    if (this.peek().kind === "minus") {
      this.consume();
      return { kind: "unary", op: "-", operand: this.parseAtom() };
    }
    return this.parseAtom();
  }

  parseAtom(): Expr {
    const t = this.peek();
    if (t.kind === "number") {
      this.consume();
      return { kind: "number", value: t.value as number };
    }
    if (t.kind === "ident") {
      this.consume();
      const name = (t.value as string).toLowerCase();
      const REGISTERS = new Set(["a", "x", "y", "sp", "pc"]);
      if (!REGISTERS.has(name)) {
        throw new Error(`Unknown identifier "${name}" — valid registers: a, x, y, sp, pc`);
      }
      return { kind: "register", reg: name };
    }
    if (t.kind === "at") {
      this.consume();
      const addr = this.parseAtom();
      return { kind: "mem_deref", addr };
    }
    if (t.kind === "lparen") {
      this.consume();
      const inner = this.parse();
      this.expect("rparen");
      return inner;
    }
    throw new Error(`Unexpected token ${t.kind} in expression`);
  }
}

// ---- Code generator: Expr → JS closure ----

type CtxEvalFn = (ctx: BreakpointContext) => number;

function generateEval(expr: Expr): CtxEvalFn {
  switch (expr.kind) {
    case "number": {
      const v = expr.value;
      return () => v;
    }
    case "register": {
      const reg = expr.reg;
      if (reg === "pc" || reg === "a" || reg === "x" || reg === "y" || reg === "sp") {
        return (ctx) => ctx.cpu[reg];
      }
      throw new Error(`Unknown register: ${reg}`);
    }
    case "mem_deref": {
      const addrFn = generateEval(expr.addr);
      return (ctx) => ctx.mem(addrFn(ctx) & 0xffff);
    }
    case "binop": {
      const l = generateEval(expr.left);
      const r = generateEval(expr.right);
      switch (expr.op) {
        case "+":   return (ctx) => (l(ctx) + r(ctx)) | 0;
        case "-":   return (ctx) => (l(ctx) - r(ctx)) | 0;
        case "*":   return (ctx) => Math.imul(l(ctx), r(ctx));
        case "/":   return (ctx) => (l(ctx) / r(ctx)) | 0;
        case "&":   return (ctx) => l(ctx) & r(ctx);
        case "|":   return (ctx) => l(ctx) | r(ctx);
        case "^":   return (ctx) => l(ctx) ^ r(ctx);
        case "===": return (ctx) => l(ctx) === r(ctx) ? 1 : 0;
        case "!==": return (ctx) => l(ctx) !== r(ctx) ? 1 : 0;
        case "<":   return (ctx) => l(ctx) < r(ctx) ? 1 : 0;
        case "<=":  return (ctx) => l(ctx) <= r(ctx) ? 1 : 0;
        case ">":   return (ctx) => l(ctx) > r(ctx) ? 1 : 0;
        case ">=":  return (ctx) => l(ctx) >= r(ctx) ? 1 : 0;
        case "&&":  return (ctx) => (l(ctx) !== 0 && r(ctx) !== 0) ? 1 : 0;
        case "||":  return (ctx) => (l(ctx) !== 0 || r(ctx) !== 0) ? 1 : 0;
        default:    throw new Error(`Unknown op: ${expr.op}`);
      }
    }
    case "unary": {
      const operandFn = generateEval(expr.operand);
      if (expr.op === "-") return (ctx) => -operandFn(ctx);
      throw new Error(`Unknown unary op: ${expr.op}`);
    }
  }
}

// ---- Public API ----

/**
 * Parse a VICE-style conditional expression string and return a
 * BreakpointContext callback that returns true when the expression
 * evaluates to a non-zero value.
 *
 * Examples:
 *   "pc == 0x05b7"
 *   "@0x0763 == 0x11"
 *   "a & 0x80"
 *   "(a > 0x10) && (x < 0x20)"
 */
export function parseViceExpression(expr: string): (ctx: BreakpointContext) => boolean {
  const tokens = tokenize(expr);
  const parser = new Parser(tokens);
  const ast = parser.parse();
  if (parser.peek().kind !== "eof") {
    throw new Error(`Unexpected tokens after expression: ${expr}`);
  }
  const evalFn = generateEval(ast);
  return (ctx) => evalFn(ctx) !== 0;
}

/**
 * Compile a VICE expression string into a BreakpointPredicate callback.
 */
export function viceExprToPredicate(expr: string): import("./breakpoints.js").BreakpointPredicate {
  const fn = parseViceExpression(expr);
  return { kind: "callback", fn };
}
