export interface OutputMask {
  mask(text: string): string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskPattern(secretValues: ReadonlyArray<string>): RegExp | undefined {
  const values = [...new Set(secretValues)]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  if (values.length === 0) return undefined;
  return new RegExp(
    `(?<![A-Za-z0-9_])(?:${values.map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`,
    "g"
  );
}

export function createOutputMask(
  secretValues: ReadonlyArray<string>
): OutputMask {
  const pattern = maskPattern(secretValues);
  const mask = (text: string): string =>
    pattern ? text.replace(pattern, "***") : text;
  return Object.freeze({ mask });
}

export type { OutputMask as OutputMaskPolicy };
