export function redactLocalPaths(text: string, cwd?: string): string {
  let out = text;
  const home = process.env.HOME || process.env.USERPROFILE;
  const pairs: [string | undefined, string][] = [
    [cwd, "${workspace}"],
    [home, "~"],
  ];
  for (const [raw, replacement] of pairs) {
    if (!raw || raw.trim() === "") {
      continue;
    }
    out = replaceAll(out, raw, replacement);
    out = replaceAll(out, raw.replaceAll("\\", "/"), replacement);
  }
  return out;
}

function replaceAll(text: string, needle: string, replacement: string): string {
  if (needle === "") {
    return text;
  }
  return text.split(needle).join(replacement);
}
