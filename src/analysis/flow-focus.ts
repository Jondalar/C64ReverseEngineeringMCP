// Spec 746.13 — the three flow lanes a retired-instruction stream is sorted into:
// main program, IRQ handler, NMI handler. BRK folds into `irq` (it shares $FFFE).
//
// Only the type lives here. The classification itself runs incrementally in
// `knowledge-graph/producers/runtime.ts`, over a firehose too large to materialize;
// the batch version that used to sit beside this type was its reference and had no
// caller left.

export type FlowKind = "main" | "irq" | "nmi";
