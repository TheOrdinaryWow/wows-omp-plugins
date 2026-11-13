const STATUSES = ["accepted", "proposed", "superseded", "deprecated", "rejected"];
const MUTED = new Set(["superseded", "rejected", "deprecated"]);

const CARD_W = 236;
const CARD_H = 100;
const COL_GAP = 76;
const ROW_GAP = 32;
const RULER_H = 44;
const MARGIN = 40;
const BAND_HEAD = 40;
const BAND_PAD = 18;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const GRID = 24;
const SVG_NS = "http://www.w3.org/2000/svg";

const fixtureMode = new URLSearchParams(location.search).has("fixture");

const $ = (id) => document.getElementById(id);
const ui = {
  repoName: $("repo-name"),
  repoRef: $("repo-ref"),
  counts: $("counts"),
  conn: $("conn"),
  connLabel: $("conn-label"),
  lanes: $("toggle-lanes"),
  mentions: $("toggle-mentions"),
  notices: $("notices"),
  workspace: document.querySelector(".workspace"),
  mapView: $("map-view"),
  viewport: $("viewport"),
  world: $("world"),
  bands: $("bands"),
  edges: $("edges"),
  cards: $("cards"),
  zoomLevel: $("zoom-level"),
  legendMention: $("legend-mention"),
  timeline: $("timeline-view"),
  empty: $("empty"),
  panel: $("panel"),
};

const state = {
  graph: null,
  index: null,
  layout: null,
  view: "map",
  lanes: false,
  mentions: false,
  selected: null,
  hovered: null,
  returnFocus: null,
  revision: null,
  loadError: null,
  viewport: { x: 0, y: 0, k: 1 },
  fitted: false,
};

// ---------- DOM helpers (text always goes in as text nodes, never as HTML) ----------

function setAttrs(node, attrs) {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "style") for (const [prop, v] of Object.entries(value)) node.style.setProperty(prop, String(v));
    else node.setAttribute(key, value === true ? "" : String(value));
  }
}

function appendChildren(node, children) {
  for (const child of children.flat(Number.POSITIVE_INFINITY)) {
    if (child === null || child === undefined || child === false || child === "") continue;
    node.append(child instanceof Node ? child : String(child));
  }
}

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  setAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

function svg(tag, attrs, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  setAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

const px = (n) => `${Math.round(n * 100) / 100}px`;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const byDate = (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id);

// ---------- Graph indexing ----------

function indexGraph(graph) {
  const byId = new Map(graph.adrs.map((adr) => [adr.id, adr]));
  const preds = new Map();
  const succs = new Map();
  const supersedeEdges = [];
  const seen = new Set();
  const link = (from, to) => {
    const key = `${from}>${to}`;
    if (seen.has(key) || !byId.has(from) || !byId.has(to) || from === to) return;
    seen.add(key);
    supersedeEdges.push({ from, to });
    preds.set(to, [...(preds.get(to) ?? []), from]);
    succs.set(from, [...(succs.get(from) ?? []), to]);
  };
  for (const adr of graph.adrs) {
    for (const prev of adr.supersedes) link(prev, adr.id);
    if (adr.supersededBy) link(adr.id, adr.supersededBy);
  }
  const incoming = new Map();
  const mentionEdges = [];
  for (const adr of graph.adrs) {
    for (const target of adr.mentions) {
      if (!byId.has(target) || target === adr.id) continue;
      mentionEdges.push({ from: adr.id, to: target });
      incoming.set(target, [...(incoming.get(target) ?? []), adr.id]);
    }
  }
  const events = new Map();
  for (const event of graph.history.events) events.set(event.adr, [...(events.get(event.adr) ?? []), event]);
  const stages = new Map(graph.stages.map((stage) => [stage.id, stage]));
  return { byId, preds, succs, supersedeEdges, mentionEdges, incoming, events, stages, order: placementOrder(graph.adrs, preds) };
}

// Date order, except that a predecessor is always placed before its successor so supersede arrows point forward.
function placementOrder(adrs, preds) {
  const sorted = [...adrs].sort(byDate);
  const placed = new Set();
  const order = [];
  while (order.length < sorted.length) {
    const ready = (adr) => !placed.has(adr.id) && (preds.get(adr.id) ?? []).every((id) => placed.has(id));
    const next = sorted.find(ready) ?? sorted.find((adr) => !placed.has(adr.id));
    placed.add(next.id);
    order.push(next);
  }
  return order;
}

function lineage(id, index) {
  const found = new Set([id]);
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    for (const next of [...(index.preds.get(current) ?? []), ...(index.succs.get(current) ?? [])]) {
      if (found.has(next)) continue;
      found.add(next);
      queue.push(next);
    }
  }
  return index.order.filter((adr) => found.has(adr.id)).map((adr) => adr.id);
}

// ---------- Map layout ----------

function laneGroups(graph, index, lanes) {
  if (!lanes) return [{ key: "", stage: null }];
  const used = [...new Set(graph.adrs.map((adr) => adr.stage).filter(Boolean))];
  used.sort((a, b) => {
    const ra = index.stages.get(a)?.round ?? "\uffff";
    const rb = index.stages.get(b)?.round ?? "\uffff";
    return ra.localeCompare(rb) || a.localeCompare(b);
  });
  const groups = used.map((id) => ({ key: id, stage: index.stages.get(id) ?? { id } }));
  if (graph.adrs.some((adr) => !adr.stage)) groups.push({ key: "", stage: null });
  return groups;
}

/*
 * Columns follow placement order and never move backwards, so reading left to right is chronological; cards that share a
 * column were placed back to back. Each lane owns its rows. A successor continues its predecessor's row when that row
 * still ends with the predecessor. A row whose last card still awaits a successor in the same lane stays reserved, so
 * unrelated cards never land inside a supersede chain. Unrelated cards fill free rows up to a soft cap (~sqrt(n/2)) to
 * keep the board roughly landscape.
 */
function computeLayout(graph, index, lanes) {
  const groups = laneGroups(graph, index, lanes);
  const groupKey = (adr) => (lanes ? (adr.stage ?? "") : "");
  const groupIndex = new Map(groups.map((group, i) => [group.key, i]));
  const sizes = groups.map((group) => graph.adrs.filter((adr) => groupKey(adr) === group.key).length);
  const rowsByGroup = groups.map(() => []);
  const cells = new Map();
  let prevCol = 0;

  for (const adr of index.order) {
    const gi = groupIndex.get(groupKey(adr));
    const rows = rowsByGroup[gi];
    const placedPreds = (index.preds.get(adr.id) ?? []).filter((id) => cells.has(id));
    let col = Math.max(prevCol, ...placedPreds.map((id) => cells.get(id).col + 1));
    let row = placedPreds.map((id) => cells.get(id)).find((cell) => cell.group === gi && rows[cell.row].tail === cell.id)?.row;
    if (row === undefined) {
      const isOpen = (r) => {
        const tail = index.byId.get(rows[r].tail);
        return !(index.succs.get(tail.id) ?? []).some((id) => !cells.has(id) && groupKey(index.byId.get(id)) === groupKey(tail));
      };
      const open = rows.map((_, r) => r).filter(isOpen);
      row = open.find((r) => rows[r].next <= col);
      if (row === undefined) {
        const cap = Math.max(1, Math.ceil(Math.sqrt(sizes[gi] / 2)));
        if (open.length === 0 || rows.length < cap) {
          row = rows.length;
          rows.push({ next: 0, tail: null });
        } else row = open.reduce((best, r) => (rows[r].next < rows[best].next ? r : best));
      }
    }
    col = Math.max(col, rows[row].next);
    rows[row] = { next: col + 1, tail: adr.id };
    cells.set(adr.id, { id: adr.id, col, row, group: gi });
    prevCol = col;
  }

  const colPitch = CARD_W + COL_GAP;
  const rowPitch = CARD_H + ROW_GAP;
  const columns = Math.max(1, ...[...cells.values()].map((cell) => cell.col + 1));
  const bands = [];
  let y = RULER_H;
  groups.forEach((group, gi) => {
    const rowCount = Math.max(1, rowsByGroup[gi].length);
    const head = lanes ? BAND_HEAD : 0;
    const pad = lanes ? BAND_PAD : 0;
    const height = head + pad * 2 + rowCount * rowPitch - ROW_GAP;
    bands.push({ ...group, top: y, height, cardsTop: y + head + pad, count: sizes[gi] });
    y += height;
  });
  const rects = new Map();
  for (const cell of cells.values()) {
    rects.set(cell.id, { x: MARGIN + cell.col * colPitch, y: bands[cell.group].cardsTop + cell.row * rowPitch, w: CARD_W, h: CARD_H });
  }
  const ticks = [];
  for (let col = 0; col < columns; col++) {
    const dates = [...cells.values()]
      .filter((cell) => cell.col === col)
      .map((cell) => index.byId.get(cell.id).date)
      .sort();
    if (dates.length === 0) continue;
    const first = dates[0];
    const last = dates[dates.length - 1];
    const label = first === last ? first : first.slice(0, 4) === last.slice(0, 4) ? `${first} → ${last.slice(5)}` : `${first} → ${last}`;
    ticks.push({ x: MARGIN + col * colPitch, label });
  }
  return { rects, bands, ticks, width: MARGIN * 2 + columns * colPitch - COL_GAP, height: y + MARGIN, lanes };
}

// ---------- Edge geometry ----------

function supersedePath(a, b) {
  if (b.x >= a.x + a.w) {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const dx = Math.max(28, (x2 - x1) / 2);
    return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
  }
  return verticalPath(a, b, 0, 0);
}

function verticalPath(a, b, offsetOut, offsetIn) {
  const x1 = a.x + a.w / 2 + offsetOut;
  const x2 = b.x + b.w / 2 + offsetIn;
  if (Math.abs(a.y - b.y) < 1) {
    const lift = ROW_GAP * 1.15;
    return `M${x1} ${a.y} C${x1} ${a.y - lift} ${x2} ${b.y - lift} ${x2} ${b.y}`;
  }
  const down = b.y > a.y;
  const y1 = down ? a.y + a.h : a.y;
  const y2 = down ? b.y : b.y + b.h;
  const dy = Math.max(24, Math.abs(y2 - y1) / 2) * (down ? 1 : -1);
  return `M${x1} ${y1} C${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`;
}

const mentionPath = (a, b) => verticalPath(a, b, 18, -18);

// ---------- Map rendering ----------

function arrowMarker(id, className) {
  return svg(
    "marker",
    { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: "userSpaceOnUse", orient: "auto" },
    svg("path", { d: "M0 0L10 5L0 10z", class: className }),
  );
}

function statusChip(status) {
  return h("span", { class: "chip", "data-status": status }, status);
}

function renderMap() {
  const { graph, index } = state;
  const layout = computeLayout(graph, index, state.lanes);
  state.layout = layout;
  ui.world.style.width = px(layout.width);
  ui.world.style.height = px(layout.height);
  ui.edges.setAttribute("width", String(layout.width));
  ui.edges.setAttribute("height", String(layout.height));

  ui.bands.replaceChildren(
    ...(layout.lanes
      ? layout.bands.map((band) =>
          h(
            "div",
            { class: "band", style: { top: px(band.top), height: px(band.height) } },
            h(
              "div",
              { class: "band-label" },
              band.stage ? h("strong", null, band.stage.id) : h("strong", null, "Unstaged"),
              band.stage?.title ? h("span", { class: "band-title" }, band.stage.title) : null,
              band.stage?.round ? h("span", null, band.stage.round) : null,
              band.stage?.status ? h("span", null, `· ${band.stage.status}`) : null,
              h("span", null, `· ${band.count} ADR${band.count === 1 ? "" : "s"}`),
            ),
          ),
        )
      : []),
    ...layout.ticks.map((tick) => h("div", { class: "ruler-tick", style: { left: px(tick.x), top: px(12) } }, tick.label)),
  );

  const edgeNodes = [];
  for (const edge of index.supersedeEdges) {
    edgeNodes.push(
      svg("path", {
        class: "edge edge-supersede",
        d: supersedePath(layout.rects.get(edge.from), layout.rects.get(edge.to)),
        "data-from": edge.from,
        "data-to": edge.to,
        "data-kind": "supersede",
        "marker-end": "url(#arrow-supersede)",
      }),
    );
  }
  if (state.mentions) {
    for (const edge of index.mentionEdges) {
      edgeNodes.push(
        svg("path", {
          class: "edge edge-mention",
          d: mentionPath(layout.rects.get(edge.from), layout.rects.get(edge.to)),
          "data-from": edge.from,
          "data-to": edge.to,
          "data-kind": "mention",
          "marker-end": "url(#arrow-mention)",
        }),
      );
    }
  }
  ui.edges.replaceChildren(
    svg(
      "defs",
      null,
      arrowMarker("arrow-supersede", "marker-supersede"),
      arrowMarker("arrow-mention", "marker-mention"),
      arrowMarker("arrow-active", "marker-active"),
    ),
    ...edgeNodes,
  );

  ui.cards.replaceChildren(...[...graph.adrs].sort(byDate).map((adr) => cardFor(adr, layout.rects.get(adr.id))));
  ui.legendMention.hidden = !state.mentions;
  highlight();
  applyTransform();
}

function cardFor(adr, rect) {
  return h(
    "button",
    {
      type: "button",
      class: "card",
      "data-id": adr.id,
      "data-focus-key": `card:${adr.id}`,
      "data-status": adr.status,
      "data-muted": MUTED.has(adr.status),
      "aria-label": `${adr.id}: ${adr.title}. Status ${adr.status}, dated ${adr.date}${adr.stage ? `, stage ${adr.stage}` : ""}`,
      title: adr.title,
      style: { left: px(rect.x), top: px(rect.y), width: px(rect.w), height: px(rect.h) },
      onclick: () => select(adr.id, "map"),
      onfocus: (event) => {
        if (event.currentTarget.matches(":focus-visible")) reveal(adr.id);
      },
      onpointerenter: () => {
        state.hovered = adr.id;
        highlight();
      },
      onpointerleave: () => {
        state.hovered = null;
        highlight();
      },
    },
    h("span", { class: "card-head" }, h("span", { class: "card-id" }, adr.id), h("time", { datetime: adr.date }, adr.date)),
    h("span", { class: "card-title" }, adr.title),
    h(
      "span",
      { class: "card-foot" },
      statusChip(adr.status),
      adr.stage ? h("span", { class: "tag" }, adr.stage) : null,
      adr.workingTree !== "clean" ? h("span", { class: "tag tag-warn wt" }, adr.workingTree) : null,
    ),
  );
}

function highlight() {
  if (!state.index) return;
  const focus = state.hovered ?? state.selected;
  const related = new Set();
  if (focus) {
    for (const id of lineage(focus, state.index)) related.add(id);
    if (state.mentions) {
      for (const id of state.index.byId.get(focus)?.mentions ?? []) related.add(id);
      for (const id of state.index.incoming.get(focus) ?? []) related.add(id);
    }
  }
  ui.cards.classList.toggle("has-focus", Boolean(focus));
  ui.edges.classList.toggle("has-focus", Boolean(focus));
  for (const card of ui.cards.children) {
    const id = card.dataset.id;
    card.classList.toggle("is-related", related.has(id));
    if (id === state.selected) card.setAttribute("aria-current", "true");
    else card.removeAttribute("aria-current");
  }
  for (const edge of ui.edges.querySelectorAll(".edge")) {
    const { from, to, kind } = edge.dataset;
    const active = Boolean(focus) && (from === focus || to === focus || (kind === "supersede" && related.has(from) && related.has(to)));
    edge.classList.toggle("is-active", active);
    edge.setAttribute("marker-end", active ? "url(#arrow-active)" : `url(#arrow-${kind})`);
    if (active) edge.parentNode.append(edge);
  }
}

// ---------- Pan and zoom ----------

function applyTransform() {
  const { x, y, k } = state.viewport;
  ui.world.style.transform = `translate(${px(x)}, ${px(y)}) scale(${k})`;
  ui.viewport.style.backgroundSize = `${px(GRID * k)} ${px(GRID * k)}`;
  ui.viewport.style.backgroundPosition = `${px(x)} ${px(y)}`;
  ui.zoomLevel.value = `${Math.round(k * 100)}%`;
}

function visibleSize() {
  const rect = ui.viewport.getBoundingClientRect();
  const covered = ui.panel.hidden || rect.width <= 600 ? 0 : ui.panel.offsetWidth;
  return { w: Math.max(120, rect.width - covered), h: rect.height };
}

function zoomAt(factor, cx, cy) {
  const vp = state.viewport;
  const k = clamp(vp.k * factor, MIN_ZOOM, MAX_ZOOM);
  const ratio = k / vp.k;
  vp.x = cx - (cx - vp.x) * ratio;
  vp.y = cy - (cy - vp.y) * ratio;
  vp.k = k;
  applyTransform();
}

function zoomCentered(factor) {
  const { w, h: height } = visibleSize();
  zoomAt(factor, w / 2, height / 2);
}

function fit() {
  if (!state.layout) return;
  const { w, h: height } = visibleSize();
  const pad = 32;
  const k = clamp(Math.min((w - pad * 2) / state.layout.width, (height - pad * 2) / state.layout.height, 1), MIN_ZOOM, MAX_ZOOM);
  state.viewport = {
    k,
    x: (w - state.layout.width * k) / 2,
    y: Math.max(pad / 2, (height - state.layout.height * k) / 2),
  };
  applyTransform();
}

function reveal(id) {
  const rect = state.layout?.rects.get(id);
  if (!rect || state.view !== "map") return;
  const { x, y, k } = state.viewport;
  const { w, h: height } = visibleSize();
  const left = x + rect.x * k;
  const top = y + rect.y * k;
  const margin = 24;
  if (left >= margin && top >= margin && left + rect.w * k <= w - margin && top + rect.h * k <= height - margin) return;
  state.viewport.x = w / 2 - (rect.x + rect.w / 2) * k;
  state.viewport.y = height / 2 - (rect.y + rect.h / 2) * k;
  applyTransform();
}

function setupPanZoom() {
  const pointers = new Map();
  const vp = () => state.viewport;
  const local = (point) => {
    const rect = ui.viewport.getBoundingClientRect();
    return { x: point.x - rect.left, y: point.y - rect.top };
  };
  const pinch = () => {
    const [a, b] = [...pointers.values()];
    return { mid: local({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }), dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  ui.viewport.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target.closest(".card")) return;
    ui.viewport.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    ui.viewport.classList.add("is-panning");
  });
  ui.viewport.addEventListener("pointermove", (event) => {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    if (pointers.size === 2) {
      const before = pinch();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const after = pinch();
      vp().x += after.mid.x - before.mid.x;
      vp().y += after.mid.y - before.mid.y;
      zoomAt(before.dist > 0 ? after.dist / before.dist : 1, after.mid.x, after.mid.y);
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    vp().x += event.clientX - prev.x;
    vp().y += event.clientY - prev.y;
    applyTransform();
  });
  const release = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) ui.viewport.classList.remove("is-panning");
  };
  ui.viewport.addEventListener("pointerup", release);
  ui.viewport.addEventListener("pointercancel", release);
  ui.viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      const point = local({ x: event.clientX, y: event.clientY });
      zoomAt(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015)), point.x, point.y);
    },
    { passive: false },
  );
  ui.mapView.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = 64;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[event.key]) {
      vp().x += moves[event.key][0];
      vp().y += moves[event.key][1];
      applyTransform();
    } else if (event.key === "+" || event.key === "=") zoomCentered(1.2);
    else if (event.key === "-" || event.key === "_") zoomCentered(1 / 1.2);
    else if (event.key === "0") fit();
    else return;
    event.preventDefault();
  });
  $("zoom-in").addEventListener("click", () => zoomCentered(1.2));
  $("zoom-out").addEventListener("click", () => zoomCentered(1 / 1.2));
  $("zoom-fit").addEventListener("click", fit);
}

// ---------- Events and timeline ----------

const KIND_COLOR = {
  created: (event) => statusLine(event.to),
  status: (event) => statusLine(event.to),
  superseded: () => statusLine("superseded"),
  stage: () => "var(--accent)",
  note: () => "var(--accent)",
  edited: () => "var(--edge)",
  deleted: () => statusLine("rejected"),
};

function statusLine(status) {
  return STATUSES.includes(status) ? `var(--status-${status}-line)` : "var(--edge)";
}

function inlineAdr(id) {
  if (!state.index?.byId.has(id)) return h("b", null, id);
  return h(
    "button",
    {
      type: "button",
      class: "inline-adr",
      title: state.index.byId.get(id).title,
      onclick: (event) => {
        event.stopPropagation();
        select(id, "panel");
      },
    },
    id,
  );
}

function describeEvent(event) {
  switch (event.kind) {
    case "created":
      return event.to ? ["Created as ", h("b", null, event.to)] : ["Created"];
    case "status":
      return ["Status ", h("b", null, event.from ?? "?"), " → ", h("b", null, event.to ?? "?")];
    case "superseded":
      return ["Superseded by ", event.to ? h("b", null, event.to) : "?"];
    case "stage":
      if (event.from && event.to) return ["Stage ", h("b", null, event.from), " → ", h("b", null, event.to)];
      return event.to ? ["Linked to stage ", h("b", null, event.to)] : ["Unlinked from stage ", h("b", null, event.from ?? "?")];
    case "note":
      return ["Note ", h("b", null, event.to ?? ""), " added"];
    case "deleted":
      return ["Deleted"];
    default:
      return ["Edited"];
  }
}

function eventMeta(event) {
  if (event.uncommitted) return h("span", { class: "tl-meta" }, h("span", { class: "tag tag-warn" }, "uncommitted"), "working tree");
  return h(
    "span",
    { class: "tl-meta" },
    event.commit ? h("code", null, event.commit) : null,
    h("span", null, event.subject),
    event.author ? h("span", null, `· ${event.author}`) : null,
  );
}

function timelineItems(graph, index) {
  const items = [];
  const notesInGit = new Set(graph.history.events.filter((e) => e.kind === "note").map((e) => `${e.adr}|${e.to}`));
  for (const adr of graph.adrs) {
    items.push({ day: adr.date, rank: 0, time: 0, kind: "dated", adr: adr.id });
    for (const note of adr.notes) {
      if (!notesInGit.has(`${adr.id}|${note.date}`))
        items.push({ day: note.date, rank: 1, time: 0, kind: "dated-note", adr: adr.id, note });
    }
  }
  for (const event of graph.history.events) {
    const note = event.kind === "note" ? index.byId.get(event.adr)?.notes.find((n) => n.date === event.to) : undefined;
    items.push({ day: event.date.slice(0, 10), rank: 2, time: Date.parse(event.date), kind: event.kind, adr: event.adr, event, note });
  }
  return items.sort((a, b) => a.day.localeCompare(b.day) || a.rank - b.rank || a.time - b.time || a.adr.localeCompare(b.adr));
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function formatDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : dayFormat.format(date);
}

function timelineRow(item, key) {
  const adr = state.index.byId.get(item.adr);
  const status = adr?.status;
  let what;
  let label;
  let color;
  if (item.kind === "dated") {
    label = "dated";
    color = statusLine(status);
    what = ["Decision dated · ", h("b", null, adr?.title ?? item.adr)];
  } else if (item.kind === "dated-note") {
    label = "note";
    color = "var(--accent)";
    what = ["Dated note ", h("b", null, item.note.date)];
  } else {
    label = item.event.uncommitted ? "now" : item.event.date.slice(11, 16);
    color = (KIND_COLOR[item.kind] ?? KIND_COLOR.edited)(item.event);
    what = describeEvent(item.event);
  }
  return h(
    "li",
    null,
    h(
      "button",
      {
        type: "button",
        class: `tl-row${item.adr === state.selected ? " is-selected" : ""}`,
        "data-kind": item.kind,
        "data-adr": item.adr,
        "data-focus-key": key,
        "data-uncommitted": item.event?.uncommitted === true,
        style: { "--kind-color": color },
        onclick: () => select(item.adr, "timeline"),
      },
      h("span", { class: "tl-time" }, label),
      h(
        "span",
        { class: "tl-adr" },
        h("span", { class: "chip", "data-status": status ?? "deprecated" }, h("span", { class: "card-id" }, item.adr)),
      ),
      h(
        "span",
        { class: "tl-main" },
        h("span", { class: "tl-what" }, what),
        item.event ? eventMeta(item.event) : null,
        item.note ? h("span", { class: "tl-note" }, item.note.text) : null,
      ),
    ),
  );
}

function renderTimeline() {
  const { graph, index } = state;
  const scroll = ui.timeline.scrollTop;
  const days = new Map();
  for (const item of timelineItems(graph, index)) days.set(item.day, [...(days.get(item.day) ?? []), item]);
  let n = 0;
  ui.timeline.replaceChildren(
    h(
      "div",
      { class: "timeline" },
      graph.history.available
        ? null
        : h(
            "div",
            { class: "notice notice-info" },
            h("strong", null, "Git history is not available."),
            h("span", null, graph.history.reason ?? "Only ADR dates and dated notes are shown."),
          ),
      [...days].map(([day, items]) => [
        h("h2", { class: "tl-day-head" }, formatDay(day), h("time", { datetime: day }, day)),
        h(
          "ul",
          { class: "tl-day" },
          items.map((item) => timelineRow(item, `row:${n++}`)),
        ),
      ]),
    ),
  );
  ui.timeline.scrollTop = scroll;
}

// ---------- Markdown ----------

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST_ITEM = /^(\s*)([*+-]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
/*
 * Inline tokens, first match wins at each position:
 * 1-2 code span, 3-4 link [text](href "title"), 5 **strong**, 6 __strong__, 7 *em*, 8 _em_ (not inside words),
 * 9 <https://autolink>, 10 bare ADR id.
 */
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<!\w)_(?=\S)([\s\S]*?\S)_(?!\w)|<(https?:\/\/[^\s>]+)>|\b(ADR-\d{4,})\b/g;

const indentOf = (line) => line.length - line.trimStart().length;

function isBlockStart(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP.test(next))
  );
}

function renderMarkdown(source, ctx) {
  const lines = source
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n");
  let start = lines.findIndex((line) => line.trim() !== "");
  const title = start >= 0 ? HEADING.exec(lines[start]) : null;
  if (title && title[1] === "#" && title[2].trim() === ctx.title.trim()) start += 1;
  return blocks(lines.slice(Math.max(0, start)), ctx);
}

function blocks(lines, ctx) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !closesFence(lines[i], marker)) body.push(lines[i++]);
      i++;
      out.push(h("pre", null, h("code", fence[2] ? { "data-lang": fence[2] } : null, body.join("\n"))));
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      out.push(h(`h${Math.min(6, heading[1].length + 2)}`, null, inline(heading[2], ctx)));
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push(h("hr"));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ""));
      out.push(h("blockquote", null, blocks(quoted, ctx)));
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = parseList(lines, i, ctx);
      out.push(list.node);
      i = list.next;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const table = parseTable(lines, i, ctx);
      out.push(table.node);
      i = table.next;
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== "" && (paragraph.length === 0 || !isBlockStart(lines[i], lines[i + 1]))) {
      paragraph.push(lines[i++].trim());
    }
    out.push(h("p", null, inline(paragraph.join(" "), ctx)));
  }
  return out;
}

function closesFence(line, marker) {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && /^(`+|~+)$/.test(trimmed) && trimmed[0] === marker[0];
}

function parseList(lines, start, ctx) {
  const first = LIST_ITEM.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const node = h(ordered ? "ol" : "ul");
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  if (startNumber !== 1) node.setAttribute("start", String(startNumber));
  let i = start;
  while (i < lines.length) {
    const item = LIST_ITEM.exec(lines[i]);
    if (!item || item[1].length !== indent || /\d/.test(item[2]) !== ordered) break;
    i++;
    const text = [item[3]];
    const children = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        const next = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
        if (j < lines.length && (indentOf(lines[j]) > indent || next?.[1].length === indent)) {
          i = j;
          continue;
        }
        break;
      }
      const nested = LIST_ITEM.exec(line);
      if (nested) {
        if (nested[1].length <= indent) break;
        const sub = parseList(lines, i, ctx);
        children.push(sub.node);
        i = sub.next;
        continue;
      }
      if (indentOf(line) > indent || (children.length === 0 && !isBlockStart(line, lines[i + 1]))) {
        text.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    node.append(h("li", null, inline(text.join(" "), ctx), children));
  }
  return { node, next: i };
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function parseTable(lines, start, ctx) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return undefined;
  });
  const cell = (tag, text, col) => h(tag, aligns[col] ? { style: { "text-align": aligns[col] } } : null, inline(text, ctx));
  let i = start + 2;
  const body = [];
  while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
    const cells = splitRow(lines[i++]);
    body.push(
      h(
        "tr",
        null,
        header.map((_, col) => cell("td", cells[col] ?? "", col)),
      ),
    );
  }
  const node = h(
    "table",
    null,
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        header.map((text, col) => cell("th", text, col)),
      ),
    ),
    h("tbody", null, body),
  );
  return { node, next: i };
}

function inline(text, ctx) {
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(inlineToken(match, ctx));
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function inlineToken(match, ctx) {
  if (match[1] !== undefined) return h("code", null, match[2]);
  if (match[3] !== undefined) return markdownLink(match[3], match[4], ctx);
  if (match[5] !== undefined || match[6] !== undefined) return h("strong", null, inline(match[5] ?? match[6], ctx));
  if (match[7] !== undefined || match[8] !== undefined) return h("em", null, inline(match[7] ?? match[8], ctx));
  if (match[9] !== undefined) return h("a", { href: match[9], target: "_blank", rel: "noopener noreferrer" }, match[9]);
  const id = match[10];
  if (ctx.plain || id === ctx.self || !state.index.byId.has(id)) return id;
  return inlineAdr(id);
}

function markdownLink(label, href, ctx) {
  const plain = { ...ctx, plain: true };
  const adrFile = /(?:^|\/)(\d{4,})-[^/]*\.md(?:#.*)?$/.exec(href);
  const linkedId = adrFile ? `ADR-${adrFile[1]}` : null;
  if (linkedId && linkedId !== ctx.self && state.index.byId.has(linkedId)) {
    const button = inlineAdr(linkedId);
    button.replaceChildren(...inline(label, plain));
    return button;
  }
  if (/^(https?:|mailto:)/i.test(href)) return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, inline(label, plain));
  return h("span", { title: href }, inline(label, plain));
}

// ---------- Detail panel ----------

function adrLink(id, current) {
  const adr = state.index.byId.get(id);
  return h(
    "li",
    null,
    h(
      "button",
      {
        type: "button",
        class: "adr-link",
        "data-status": adr.status,
        "aria-current": current ? "true" : undefined,
        onclick: current ? undefined : () => select(id, "panel"),
      },
      h("span", { class: "dot", "aria-hidden": "true" }),
      h("span", { class: "id" }, id),
      h("span", { class: "ttl" }, adr.title),
      h("span", { class: "chip", "data-status": adr.status }, adr.status),
    ),
  );
}

function section(title, ...content) {
  return h("section", { class: "section" }, h("h3", null, title), content);
}

function metaList(adr) {
  const stage = adr.stage ? state.index.stages.get(adr.stage) : null;
  const people = (list) => (list.length > 0 ? list.join(", ") : "—");
  const rows = [
    ["Date", h("time", { datetime: adr.date }, adr.date)],
    adr.stage
      ? [
          "Stage",
          [
            h("b", null, adr.stage),
            stage?.title ? ` · ${stage.title}` : "",
            stage?.round ? ` · ${stage.round}` : "",
            stage?.status ? ` · ${stage.status}` : "",
          ],
        ]
      : null,
    ["Decision makers", people(adr.decisionMakers)],
    ["Consulted", people(adr.consulted)],
    ["Informed", people(adr.informed)],
    [
      "File",
      [
        h("span", { class: "path" }, adr.path),
        adr.workingTree !== "clean" ? [" ", h("span", { class: "tag tag-warn" }, adr.workingTree)] : null,
      ],
    ],
  ];
  return h(
    "dl",
    { class: "meta" },
    rows.filter(Boolean).map(([term, value]) => [h("dt", null, term), h("dd", null, value)]),
  );
}

function historyList(adr) {
  const { history } = state.graph;
  if (!history.available) return h("p", { class: "muted" }, `Git history is not available${history.reason ? `: ${history.reason}` : "."}`);
  const events = state.index.events.get(adr.id) ?? [];
  if (events.length === 0) return h("p", { class: "muted" }, "No recorded changes in git history.");
  return h(
    "ul",
    { class: "history" },
    events.map((event) =>
      h(
        "li",
        null,
        h("time", { datetime: event.date }, event.uncommitted ? "uncommitted" : event.date.slice(0, 10)),
        h("span", null, h("span", { class: "tl-what" }, describeEvent(event)), eventMeta(event)),
      ),
    ),
  );
}

function renderPanel() {
  const adr = state.selected ? state.index.byId.get(state.selected) : null;
  if (!adr) {
    ui.panel.hidden = true;
    ui.workspace.classList.remove("panel-open");
    return;
  }
  const sameAdr = ui.panel.dataset.id === adr.id;
  const scroll = ui.panel.scrollTop;
  const chain = lineage(adr.id, state.index);
  const mentions = adr.mentions.filter((id) => state.index.byId.has(id));
  const mentionedBy = state.index.incoming.get(adr.id) ?? [];
  ui.panel.dataset.id = adr.id;
  ui.panel.replaceChildren(
    h(
      "div",
      { class: "panel-head" },
      h("span", { class: "panel-id" }, adr.id),
      statusChip(adr.status),
      h("button", { type: "button", class: "panel-close", "aria-label": "Close details", onclick: closePanel }, "\u00d7"),
    ),
    h(
      "div",
      { class: "panel-body" },
      h("h2", { id: "panel-title", class: "panel-title", tabindex: "-1" }, adr.title),
      metaList(adr),
      chain.length > 1
        ? section(
            "Supersession chain",
            h(
              "ol",
              { class: "links chain" },
              chain.map((id) => adrLink(id, id === adr.id)),
            ),
          )
        : null,
      mentions.length > 0
        ? section(
            "Mentions",
            h(
              "ul",
              { class: "links" },
              mentions.map((id) => adrLink(id, false)),
            ),
          )
        : null,
      mentionedBy.length > 0
        ? section(
            "Mentioned by",
            h(
              "ul",
              { class: "links" },
              mentionedBy.map((id) => adrLink(id, false)),
            ),
          )
        : null,
      section("History", historyList(adr)),
      section("Record", h("div", { class: "prose" }, renderMarkdown(adr.body, { self: adr.id, title: adr.title }))),
    ),
  );
  ui.panel.hidden = false;
  ui.workspace.classList.add("panel-open");
  ui.panel.scrollTop = sameAdr ? scroll : 0;
}

function markTimelineSelection() {
  for (const row of ui.timeline.querySelectorAll(".tl-row")) row.classList.toggle("is-selected", row.dataset.adr === state.selected);
}

function select(id, from) {
  if (!state.index.byId.has(id)) return;
  if (from !== "panel" || !state.returnFocus) {
    const key = document.activeElement?.dataset?.focusKey;
    state.returnFocus = key ?? (from === "map" ? `card:${id}` : null);
  }
  state.selected = id;
  renderPanel();
  highlight();
  markTimelineSelection();
  reveal(id);
  $("panel-title")?.focus({ preventScroll: true });
}

function closePanel() {
  state.selected = null;
  renderPanel();
  highlight();
  markTimelineSelection();
  const key = state.returnFocus;
  state.returnFocus = null;
  if (key) document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

// ---------- Header, notices, views ----------

function renderHeader() {
  const { graph } = state;
  ui.repoName.textContent = graph.repo.name;
  document.title = `${graph.repo.name} · decision records`;
  const ref = [graph.repo.branch, graph.repo.head ? `@ ${graph.repo.head}` : null].filter(Boolean).join(" ");
  ui.repoRef.textContent = `${ref || "no commits yet"} · ${graph.adrs.length} ADR${graph.adrs.length === 1 ? "" : "s"}`;
  ui.counts.replaceChildren(
    ...STATUSES.map((status) => {
      const count = graph.adrs.filter((adr) => adr.status === status).length;
      return h(
        "li",
        { "data-zero": count === 0 },
        h("span", { class: "chip", "data-status": status }, status, h("span", { class: "chip-count" }, count)),
      );
    }),
  );
}

function renderNotices() {
  const errors = state.graph?.parseErrors ?? [];
  ui.notices.replaceChildren();
  appendChildren(ui.notices, [
    state.loadError ? h("div", { class: "notice" }, h("strong", null, "Refresh failed."), h("span", null, state.loadError)) : null,
    errors.length > 0
      ? h(
          "div",
          { class: "notice" },
          h(
            "details",
            null,
            h(
              "summary",
              null,
              `${errors.length} ADR file${errors.length === 1 ? "" : "s"} could not be parsed and ${errors.length === 1 ? "is" : "are"} not shown`,
            ),
            h(
              "ul",
              null,
              errors.map((error) => h("li", null, `${error.path} — ${error.message}`)),
            ),
          ),
        )
      : null,
  ]);
}

const EMPTY_STATES = {
  absent: [
    "No ADR directory yet",
    [
      "This repository has no ",
      h("code", null, "docs/adr"),
      " directory. Run ",
      h("code", null, "/adr init"),
      " in omp to start recording decisions.",
    ],
  ],
  empty: ["The ADR directory is empty", ["Run ", h("code", null, "/adr init"), " in omp to set it up."]],
  unmanaged: [
    "ADRs are not managed yet",
    [h("code", null, "docs/adr"), " exists but has no ADR index. Run ", h("code", null, "/adr init"), " in omp to adopt it."],
  ],
  managed: [
    "No decisions recorded yet",
    ["Start one with ", h("code", null, "/adr new"), " in omp; it appears here as soon as it is written."],
  ],
};

function renderEmpty(title, text) {
  ui.empty.replaceChildren(h("div", { class: "empty-box" }, h("h2", null, title), h("p", null, text)));
}

function syncViews() {
  const hasData = state.graph?.state === "managed" && state.graph.adrs.length > 0;
  ui.empty.hidden = hasData;
  ui.mapView.hidden = !hasData || state.view !== "map";
  ui.timeline.hidden = !hasData || state.view !== "timeline";
  for (const button of document.querySelectorAll("[data-view]"))
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  ui.lanes.disabled = !hasData || state.view !== "map";
  ui.mentions.disabled = !hasData || state.view !== "map";
  ui.lanes.setAttribute("aria-pressed", String(state.lanes));
  ui.mentions.setAttribute("aria-pressed", String(state.mentions));
}

function renderAll() {
  const { graph } = state;
  const focusKey = document.activeElement?.dataset?.focusKey;
  renderHeader();
  renderNotices();
  if (graph.state !== "managed" || graph.adrs.length === 0) {
    const [title, text] = EMPTY_STATES[graph.state] ?? EMPTY_STATES.managed;
    renderEmpty(title, text);
    state.selected = null;
    renderPanel();
    syncViews();
    return;
  }
  syncViews();
  renderMap();
  renderTimeline();
  renderPanel();
  if (!state.fitted) {
    fit();
    state.fitted = true;
  }
  if (focusKey) document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

function setView(view) {
  state.view = view;
  syncViews();
  if (view === "map" && state.layout && !state.fitted) fit();
}

// ---------- Data loading and live updates ----------

let loading = false;
let reloadQueued = false;

async function loadGraph() {
  if (loading) {
    reloadQueued = true;
    return;
  }
  loading = true;
  try {
    const response = await fetch(fixtureMode ? "fixture.json" : "api/graph", { cache: "no-store" });
    if (!response.ok) throw new Error(`The server answered ${response.status} ${response.statusText}.`);
    const graph = await response.json();
    state.graph = graph;
    state.index = indexGraph(graph);
    state.loadError = null;
    if (state.selected && !state.index.byId.has(state.selected)) state.selected = null;
    renderAll();
  } catch (error) {
    state.loadError = error instanceof Error ? error.message : String(error);
    if (state.graph) renderNotices();
    else {
      renderEmpty("Could not load the decision records", state.loadError);
      syncViews();
    }
  } finally {
    loading = false;
    if (reloadQueued) {
      reloadQueued = false;
      loadGraph();
    }
  }
}

function setConnection(kind, label, detail) {
  ui.conn.dataset.state = kind;
  ui.connLabel.textContent = label;
  ui.conn.title = detail ?? "";
}

let retryDelay = 1000;

function connect() {
  setConnection("connecting", "Connecting", "Opening the live update stream");
  const source = new EventSource("api/events");
  source.addEventListener("open", () => {
    retryDelay = 1000;
    setConnection("live", "Live", "Updates appear as ADR files or git history change");
  });
  source.addEventListener("message", (event) => {
    let revision;
    try {
      revision = JSON.parse(event.data).revision;
    } catch {
      return;
    }
    setConnection("live", "Live", "Updates appear as ADR files or git history change");
    if (revision === state.revision) return;
    state.revision = revision;
    loadGraph();
  });
  source.addEventListener("error", () => {
    // A restarted server may count revisions from scratch, so the next revision always triggers a refetch.
    state.revision = null;
    if (!state.graph)
      renderEmpty("Waiting for the ADR server", "The page reconnects on its own. If omp has closed, run /adr visualize again.");
    if (source.readyState === EventSource.CLOSED) {
      source.close();
      setConnection("disconnected", "Disconnected", `Retrying in ${Math.round(retryDelay / 1000)} s`);
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 15000);
    } else setConnection("disconnected", "Disconnected", "Reconnecting…");
  });
}

// ---------- Startup ----------

function start() {
  for (const button of document.querySelectorAll("[data-view]")) button.addEventListener("click", () => setView(button.dataset.view));
  ui.lanes.addEventListener("click", () => {
    state.lanes = !state.lanes;
    syncViews();
    renderMap();
    fit();
  });
  ui.mentions.addEventListener("click", () => {
    state.mentions = !state.mentions;
    syncViews();
    renderMap();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.selected) {
      event.preventDefault();
      closePanel();
    }
  });
  setupPanZoom();
  renderEmpty("Loading decision records", fixtureMode ? "Reading fixture.json…" : "Connecting to the ADR server…");
  syncViews();
  if (fixtureMode) {
    setConnection("fixture", "Fixture", "Showing fixture.json; live updates are off");
    loadGraph();
  } else connect();
}

start();
