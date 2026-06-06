export function redactLocalPaths(text: string, cwd?: string): string {
  let out = text;
  const home = process.env.HOME || process.env.USERPROFILE;
  for (const raw of [cwd, home]) {
    if (!raw || raw.trim() === "") {
      continue;
    }
    out = replaceAll(out, raw, raw === home ? "~" : "${workspace}");
    out = replaceAll(out, raw.replaceAll("\\", "/"), raw === home ? "~" : "${workspace}");
  }
  return out;
}

function replaceAll(text: string, needle: string, replacement: string): string {
  if (needle === "") {
    return text;
  }
  return text.split(needle).join(replacement);
}
