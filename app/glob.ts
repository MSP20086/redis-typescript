const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export function globToRegExp(pattern: string, flags = ""): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else if (char === "\\" && i + 1 < pattern.length) {
      source += escapeRegExp(pattern[++i]);
    } else if (char === "[" && pattern.indexOf("]", i + 1) !== -1) {
      const close = pattern.indexOf("]", i + 1);
      let set = pattern.slice(i + 1, close);
      const negated = set.startsWith("^");
      if (negated) {
        set = set.slice(1);
      }
      source += `[${negated ? "^" : ""}${set.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`, `s${flags}`);
}
