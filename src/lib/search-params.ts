export function readParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }

  return value ?? '';
}

export function readOptionalNumberParam(value: string | string[] | undefined): number | undefined {
  const raw = readParam(value).trim();
  if (raw === '') {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readNumberParam(value: string | string[] | undefined, fallback: number): number {
  return readOptionalNumberParam(value) ?? fallback;
}
