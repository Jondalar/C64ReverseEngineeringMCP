import { readFileSync, existsSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { SegmentKind } from "../analysis/types";

export interface SegmentAnnotation {
  start: string;        // hex address, e.g. "09A9"
  end: string;          // hex address, e.g. "09AA"
  kind: SegmentKind;    // reclassified segment type
  label?: string;       // semantic label, e.g. "sprite_scroller_flag"
  comment?: string;     // human-readable explanation
}

export interface LabelAnnotation {
  address: string;      // hex address
  label: string;        // semantic name, e.g. "main_entry"
  comment?: string;     // optional inline comment for the label
}

export interface RoutineAnnotation {
  address: string;      // hex start address of routine
  name: string;         // descriptive routine name
  comment: string;      // what the routine does (block comment)
}

export interface AnnotationsFile {
  version: number;
  binary: string;       // which PRG this annotates
  segments: SegmentAnnotation[];
  labels: LabelAnnotation[];
  routines: RoutineAnnotation[];
}

export interface AnnotationsIndex {
  segmentsByStart: Map<number, SegmentAnnotation>;
  labelsByAddress: Map<number, LabelAnnotation>;
  routinesByAddress: Map<number, RoutineAnnotation>;
}

function parseHex(hex: string): number {
  return parseInt(hex.replace(/^\$/, ""), 16);
}

export function buildAnnotationsIndex(annotations: AnnotationsFile): AnnotationsIndex {
  const segmentsByStart = new Map<number, SegmentAnnotation>();
  const labelsByAddress = new Map<number, LabelAnnotation>();
  const routinesByAddress = new Map<number, RoutineAnnotation>();

  for (const seg of annotations.segments) {
    segmentsByStart.set(parseHex(seg.start), seg);
  }
  for (const lbl of annotations.labels) {
    labelsByAddress.set(parseHex(lbl.address), lbl);
  }
  for (const rt of annotations.routines) {
    routinesByAddress.set(parseHex(rt.address), rt);
  }

  return { segmentsByStart, labelsByAddress, routinesByAddress };
}

export function loadAnnotations(prgPath: string, explicitPath?: string): AnnotationsFile | undefined {
  if (explicitPath) {
    const p = resolve(explicitPath);
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf8")) as AnnotationsFile;
    }
  }

  const parsed = parse(prgPath);
  const candidates = [
    resolve(dirname(prgPath), `${parsed.name}_annotations.json`),
    resolve(dirname(prgPath), "annotations.json"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8")) as AnnotationsFile;
    }
  }

  return undefined;
}
