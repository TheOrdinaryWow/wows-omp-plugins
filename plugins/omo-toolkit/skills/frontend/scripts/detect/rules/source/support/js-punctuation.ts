// Modified OMP port of oh-my-openagent at adddd17004076e799c2de18ccfdee29e12525ace (Sustainable Use License 1.0: ../../../../../../../LICENSE-SUL-1.0).
// Adapted from the Impeccable detector (Apache-2.0, Copyright 2025 Paul Bakaus); licenses and changes: ../../../../../ATTRIBUTION.md section 7.
type Punctuation = { readonly ch: string; readonly at: number; readonly paren: number; readonly brace: number };

export function* jsPunctuation(text: string): Generator<Punctuation> {
  let quote = "";
  let template = false;
  let paren = 0;
  let brace = 0;
  const interpolations: number[] = [];
  for (let at = 0; at < text.length; at++) {
    const ch = text[at] ?? "";
    if (quote) {
      if (ch === "\\") at++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (template && interpolations.length === 0) {
      if (ch === "\\") at++;
      else if (ch === "$" && text[at + 1] === "{") {
        interpolations.push(++brace);
        at++;
      } else if (ch === "`") template = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "`") {
      template = true;
      continue;
    }
    if (ch === "(") {
      paren++;
      continue;
    }
    if (ch === ")") {
      paren--;
      continue;
    }
    if (ch === "{") {
      brace++;
      continue;
    }
    if (ch === "}") {
      brace--;
      if (interpolations.length > 0 && brace < (interpolations.at(-1) ?? 0)) interpolations.pop();
      continue;
    }
    yield { ch, at, paren, brace };
  }
}
