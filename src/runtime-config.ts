export function booleanSetting(value: string | undefined, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'true' && normalized !== 'false')
    throw new Error(`${name} must be true or false`);
  return normalized === 'true';
}

export function integerSetting(
  value: string | undefined,
  name: string,
  fallback: number,
  min = 1,
  max = 300000
): number {
  if (value === undefined) return fallback;
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return Number(value);
}
