export function booleanSetting(value: string | undefined, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'true' && normalized !== 'false')
    throw new Error(`${name} must be true or false`);
  return normalized === 'true';
}
