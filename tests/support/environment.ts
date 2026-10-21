const original = new Map<string, string | undefined>();
export function setEnv(name: string, value: string | undefined): void {
  if (!original.has(name)) original.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
export function restoreEnv(): void {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  original.clear();
}
