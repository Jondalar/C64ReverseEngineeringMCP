export function hex8(value: number): string {
  return value.toString(16).padStart(2, "0");
}

export function hex16(value: number): string {
  return value.toString(16).padStart(4, "0");
}

export function slugify(label: string): string {
  return label.toLowerCase().replaceAll(/[ _/]+/g, "-");
}
