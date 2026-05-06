// Spec 200 — Kernel trace stub.
//
// Full event schema, ring buffer, JSONL artifact, and producer wiring
// land in Spec 205. This stub keeps the MachineKernel surface stable so
// V2/V3 client code can be written against it from day one.

export interface KernelTraceEvent {
  // Schema deferred to Spec 205. Concrete events arrive then.
  readonly _placeholder?: never;
}

export interface KernelTraceController {
  subscribe(handler: (event: KernelTraceEvent) => void): () => void;
  read(): readonly KernelTraceEvent[];
}

export class KernelTraceStub implements KernelTraceController {
  subscribe(_handler: (event: KernelTraceEvent) => void): () => void {
    return () => undefined;
  }

  read(): readonly KernelTraceEvent[] {
    return [];
  }
}
