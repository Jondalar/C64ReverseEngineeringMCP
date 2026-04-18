import { readFile } from "node:fs/promises";

export interface AnnotationSegment {
  start: string;
  end: string;
  kind: string;
  label?: string;
  comment?: string;
}

export interface AnnotationLabel {
  address: string;
  label: string;
  comment?: string;
}

export interface AnnotationRoutine {
  address: string;
  name: string;
  comment?: string;
}

export interface AnnotationFile {
  version: number;
  binary: string;
  segments?: AnnotationSegment[];
  labels?: AnnotationLabel[];
  routines?: AnnotationRoutine[];
}

export interface ViceTraceSemanticLink {
  label?: string;
  labelComment?: string;
  routineAddress?: number;
  routineName?: string;
  routineComment?: string;
  segmentStart?: number;
  segmentEnd?: number;
  segmentKind?: string;
  segmentLabel?: string;
  segmentComment?: string;
}

interface LoadedSemanticResolver {
  resolve(pc: number): ViceTraceSemanticLink | undefined;
  annotations: AnnotationFile;
}

export async function loadSemanticResolver(
  annotationsPath?: string,
): Promise<LoadedSemanticResolver | undefined> {
  if (!annotationsPath) {
    return undefined;
  }

  let annotations: AnnotationFile;
  try {
    annotations = JSON.parse(await readFile(annotationsPath, "utf8")) as AnnotationFile;
  } catch {
    return undefined;
  }

  const labels = new Map<number, AnnotationLabel>();
  const segments = (annotations.segments ?? [])
    .map((segment) => ({
      ...segment,
      startNum: parseHex(segment.start),
      endNum: parseHex(segment.end),
    }))
    .sort((left, right) => left.startNum - right.startNum || left.endNum - right.endNum);
  const routines = (annotations.routines ?? [])
    .map((routine) => ({
      ...routine,
      addressNum: parseHex(routine.address),
    }))
    .sort((left, right) => left.addressNum - right.addressNum);

  for (const label of annotations.labels ?? []) {
    labels.set(parseHex(label.address), label);
  }

  return {
    annotations,
    resolve: (pc: number) => {
      const label = labels.get(pc);
      const segment = findContainingSegment(segments, pc);
      const routine = findOwningRoutine(routines, pc, segment?.startNum, segment?.endNum);

      if (!label && !segment && !routine) {
        return undefined;
      }

      return {
        label: label?.label,
        labelComment: label?.comment,
        routineAddress: routine?.addressNum,
        routineName: routine?.name,
        routineComment: routine?.comment,
        segmentStart: segment?.startNum,
        segmentEnd: segment?.endNum,
        segmentKind: segment?.kind,
        segmentLabel: segment?.label,
        segmentComment: segment?.comment,
      };
    },
  };
}

export function parseHex(value: string): number {
  return parseInt(value.replace(/^\$/, ""), 16);
}

function findContainingSegment(
  segments: Array<AnnotationSegment & { startNum: number; endNum: number }>,
  pc: number,
): (AnnotationSegment & { startNum: number; endNum: number }) | undefined {
  return segments.find((segment) => segment.startNum <= pc && pc <= segment.endNum);
}

function findOwningRoutine(
  routines: Array<AnnotationRoutine & { addressNum: number }>,
  pc: number,
  segmentStart?: number,
  segmentEnd?: number,
): (AnnotationRoutine & { addressNum: number }) | undefined {
  let candidate: (AnnotationRoutine & { addressNum: number }) | undefined;
  for (const routine of routines) {
    if (routine.addressNum > pc) {
      break;
    }
    if (segmentStart !== undefined && segmentEnd !== undefined) {
      if (routine.addressNum < segmentStart || routine.addressNum > segmentEnd) {
        continue;
      }
    }
    candidate = routine;
  }
  return candidate;
}
