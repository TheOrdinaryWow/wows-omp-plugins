/**
 * pi-tui nodes built by plain calls. Plugin files avoid JSX because omp's extension loader does not rewrite the
 * runtime import a `@jsxImportSource @oh-my-pi/pi-tui` file compiles to: compiled omp cannot resolve it and npm omp
 * resolves it to a second pi-tui whose nodes the host does not recognise.
 */
import { type JSX, type JSXNode, jsx, type UiNode } from "@oh-my-pi/pi-tui";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";

export type Tag = keyof JSX.IntrinsicElements;
export type Attrs<K extends Tag> = JSX.IntrinsicElements[K];

/** A node of `kind`; `children` become its children in order (nested arrays, accessors and `undefined` allowed). */
export function h<K extends Tag>(kind: K, attrs?: Attrs<K>, ...children: JSXNode[]): UiNode {
  const props = children.length === 0 ? { ...attrs } : { ...attrs, children };
  return jsx(kind, props) as UiNode;
}

/** One styled span; `s` is a space-separated list of semantic or theme tokens. */
export function span(t: string, s?: string): TspSpan {
  return s === undefined ? { t } : { t, s };
}

/** A `kv` grid from label/value pairs with muted labels, skipping empty values; undefined when nothing is left. */
export function kv(pairs: readonly (readonly [string, TspText | undefined])[]): UiNode | undefined {
  const items: { k: TspText; v: TspText }[] = [];
  for (const [label, value] of pairs) {
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue;
    items.push({ k: [span(label, "muted")], v: value });
  }
  return items.length > 0 ? h("kv", { items }) : undefined;
}
