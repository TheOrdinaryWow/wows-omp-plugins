export const HEADLESS_USAGE = '/switch-until <model> --until "<goal>" [--context "<text>"]';

export interface HeadlessArgs {
  selector: string;
  goal: string;
  context?: string;
}

export function parseHeadlessArgs(raw: string): HeadlessArgs {
  const words = /(?:"((?:\\["\\]|[^"\\]|\\(?!["\\]))*)"|'([^']*)'|([^\s"']+))(?=\s|$)/gy;
  const tokens: { value: string; bare: boolean }[] = [];
  let rest = raw.trim();
  while (rest) {
    words.lastIndex = 0;
    const match = words.exec(rest);
    if (!match) throw new Error(`Check the quoting. Usage: ${HEADLESS_USAGE}`);
    const [, doubleQuoted, singleQuoted, bare] = match;
    tokens.push({ value: doubleQuoted?.replace(/\\(["\\])/g, "$1") ?? singleQuoted ?? bare ?? "", bare: bare !== undefined });
    rest = rest.slice(words.lastIndex).trimStart();
  }

  const selector = tokens.shift()?.value.trim();
  const flags = new Map<string, string>();
  while (tokens.length) {
    const [name, value] = tokens.splice(0, 2);
    if (
      !name?.bare ||
      (name.value !== "--until" && name.value !== "--context") ||
      !value ||
      (value.bare && value.value.startsWith("--")) ||
      flags.has(name.value)
    ) {
      throw new Error(`Usage: ${HEADLESS_USAGE}`);
    }
    flags.set(name.value, value.value.trim());
  }
  const goal = flags.get("--until");
  if (!selector || selector.startsWith("--") || !goal || /[\r\n]/.test(goal)) throw new Error(`Usage: ${HEADLESS_USAGE}`);
  return { selector, goal, context: flags.get("--context") || undefined };
}
