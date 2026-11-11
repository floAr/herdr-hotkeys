// Hotkeys: a coach for Herdr's shortcuts. Herdr can't say whether a command came
// from a key or a click, so the shown layout routes its shortcuts through this
// mod (keys.json `layout:<name>`: "alt-1": "coach.space.select:1", written by
// "Set up keys"). Any change on screen with no key just before it was done by
// hand: a toast shows its key.
//
// Two kinds of copy: the bar (no props) watches and counts; the list
// ({ view: "panel" }, in a side panel stack or a dialog) shows what you do by
// hand most.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  spaces,
  panes,
  focused,
  layout,
  keys,
  run,
  notify,
  nextCommand,
  shared,
  setShared,
  theme,
  props,
  window,
  appHome,
  readTextFile,
  writeTextFile,
  openOverlay,
  closeOverlay,
} from "herdr";

// A change this soon after a routed key was that key's doing.
const KEY_WINDOW = 1500;
// The same toast again only after this long, so clicking through tabs isn't a flood.
const COOLDOWN = 4000;
// Free keys offered for things without one, first unused wins.
const SPARE = [
  "ctrl-shift-j",
  "ctrl-shift-m",
  "ctrl-shift-u",
  "ctrl-shift-y",
  "ctrl-shift-g",
  "ctrl-shift-d",
  "ctrl-shift-r",
  "alt-s",
  "alt-d",
  "alt-f",
  "alt-g",
];
const PANELS = {
  files: "Files",
  changes: "Changes",
  resources: "Resources",
  trail: "Decisions",
  hotkeys: "Hotkeys",
};
const LABEL = {
  "space.new": "New space",
  "space.next": "Next space",
  "space.prev": "Previous space",
  "space.rename": "Rename space",
  "tab.new": "New tab",
  "tab.close": "Close tab",
  "tab.next": "Next tab",
  "tab.prev": "Previous tab",
  "tab.rename": "Rename tab",
  "tab.settle": "Put a tab away",
  "pane.go": "Move to another pane",
  "pane.split": "Split the pane",
  "pane.close": "Close the pane",
  "pane.zoom": "Zoom the pane",
  "layout.toggle:sidebar": "Show or hide the sidebar",
  "layout.switch": "Switch layout",
  "panel.hide": "Close the side panel",
};
// Families: one entry for every direction of the same move.
const FAMILY = { "pane.go": "pane.go:", "pane.split": "pane.split:" };
// The shortcuts worth coaching: moving around and arranging. Zoom, help,
// palette and settings stay as they are.
const COACHED = /^(space|tab|pane|agent)\.|^layout\.(toggle|switch)/;

function label(id) {
  if (LABEL[id]) return LABEL[id];
  const [name, value] = id.split(":");
  if (name === "space.select") return `Go to space ${value}`;
  if (name === "tab.select") return `Go to tab ${value}`;
  if (name === "panel") return `Open the ${PANELS[value] ?? value} panel`;
  return id;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function togglePanel(child) {
  const l = layout();
  if (
    find(l, "panel")?.hidden === false &&
    find(l, "panel-body")?.active === child
  )
    run("layout.hide", { id: "panel" });
  else {
    run("layout.select", { stack: "panel-body", child });
    run("layout.show", { id: "panel" });
  }
}

// "alt-shift-h" -> "Alt+Shift+H", as the status bar's palette hint spells keys.
function pretty(k) {
  const mod = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: "Cmd" };
  const parts = k.endsWith("--")
    ? [...k.slice(0, -2).split("-"), "-"]
    : k.split("-");
  return parts
    .map(
      (p) =>
        mod[p] ??
        (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)),
    )
    .join("+");
}

// Every key that does `id` anywhere, what the routed copy calls it included.
function keysFor(id) {
  const prefix = FAMILY[id];
  const hits = (a) => {
    const plain = a.startsWith("coach.") ? a.slice(6) : a;
    return prefix ? plain.startsWith(prefix) : plain === id;
  };
  const seen = new Set();
  for (const k of keys()) if (hits(k.action)) seen.add(k.keys);
  return [...seen];
}

// Where a binding for `id` points: coach's own commands only exist where it's routed.
const bindingFor = (id) => (id.startsWith("panel") ? `coach.${id}` : id);

const today = () => new Date().toISOString().slice(0, 10);

// The keys.json section for the shown layout, where the routing lives.
const section = () => `layout:${shared("layout") ?? "main"}`;

// Whether this layout's keys come through here; until then a key and a click
// look the same, so nothing is counted.
const routed = () =>
  keys().some((k) => k.section === section() && k.action.startsWith("coach."));

async function editKeys(change) {
  const path = `${appHome()}/keys.json`;
  const text = await readTextFile(path).catch(() => null);
  const all = JSON.parse(text ?? "{}");
  change(all);
  await writeTextFile(path, JSON.stringify(all, null, 2) + "\n", text);
}

// Copy every coached global shortcut into this layout's section as `coach.<action>`.
// Keys the layout already binds its own way are left alone.
function routeKeys() {
  const name = section();
  return editKeys((all) => {
    const own = { ...all[name] };
    for (const k of keys())
      if (k.section === "global" && COACHED.test(k.action) && !(k.keys in own))
        own[k.keys] = `coach.${k.action}`;
    all[name] = own;
  });
}

function unrouteKeys() {
  const name = section();
  return editKeys((all) => {
    const own = Object.fromEntries(
      Object.entries(all[name] ?? {}).filter(
        ([, a]) => !(typeof a === "string" && a.startsWith("coach.")),
      ),
    );
    if (Object.keys(own).length) all[name] = own;
    else delete all[name];
  });
}

// The list opens in the layout's side panel when it has a `hotkeys` child,
// else as a dialog.
function openList() {
  if (find(layout(), "panel-body")?.children?.some((c) => c.id === "hotkeys"))
    togglePanel("hotkeys");
  else
    openOverlay({
      mod: "coach",
      props: { view: "panel" },
      kind: "dialog",
      width: 440,
      height: 560,
    });
}

function snap() {
  const ss = spaces();
  const s = ss.find((x) => x.active);
  const tab = s?.tabs.find((t) => t.active);
  const here = panes().filter((p) => p.tab === tab?.id);
  const l = layout();
  return {
    layout: shared("layout"),
    spaces: ss.map((x) => x.id),
    spaceNames: Object.fromEntries(
      ss.map((x) => [x.id, x.named ? x.name : null]),
    ),
    space: s?.id,
    spaceIndex: s?.index,
    tabs: s?.tabs.map((t) => t.id) ?? [],
    tab: tab?.id,
    tabIndex: tab?.index,
    tabName: tab?.named ? tab.name : null,
    settled: s?.tabs.filter((t) => t.settled).length ?? 0,
    panes: here.map((p) => p.pane),
    pane: focused()?.pane ?? null,
    zoom: here.some((p) => p.zoomed),
    sidebar: find(l, "sidebar")?.hidden === true,
    panel:
      find(l, "panel")?.hidden === false
        ? (find(l, "panel-body")?.active ?? null)
        : null,
  };
}

// What the person did between two snapshots, as the commands a key could have run
// (first one with a key wins), or nothing for changes no key makes.
function changes(a, b) {
  const out = [];
  const step = (kind, from, to, index) => {
    const ids = [`${kind}.select:${index}`];
    if (to === from + 1) ids.push(`${kind}.next`);
    if (to === from - 1) ids.push(`${kind}.prev`);
    return ids;
  };
  if (a.layout !== b.layout) return [["layout.switch"]];
  if (b.space !== a.space) {
    if (!a.spaces.includes(b.space)) out.push(["space.new"]);
    // Its space closing moves you elsewhere; that's not a pick.
    else if (b.spaces.includes(a.space))
      out.push(step("space", a.spaceIndex, b.spaceIndex, b.spaceIndex));
  } else if (b.tab !== a.tab) {
    if (!a.tabs.includes(b.tab)) out.push(["tab.new"]);
    // Only the tab you were on closing is you closing it; one in the
    // background going away is its program ending.
    else if (!b.tabs.includes(a.tab)) out.push(["tab.close"]);
    else out.push(step("tab", a.tabIndex, b.tabIndex, b.tabIndex));
  } else {
    if (b.panes.length > a.panes.length) out.push(["pane.split"]);
    else if (b.panes.length < a.panes.length && !b.panes.includes(a.pane))
      out.push(["pane.close"]);
    else if (a.zoom !== b.zoom) out.push(["pane.zoom"]);
    else if (a.pane && b.pane && a.pane !== b.pane) out.push(["pane.go"]);
    if (b.tabName && a.tabName !== b.tabName) out.push(["tab.rename"]);
    if (b.settled > a.settled) out.push(["tab.settle"]);
  }
  const named = b.spaceNames[b.space];
  if (named && a.spaceNames[b.space] !== named && a.space === b.space)
    out.push(["space.rename"]);
  if (a.sidebar !== b.sidebar) out.push(["layout.toggle:sidebar"]);
  if (a.panel !== b.panel)
    out.push([b.panel ? `panel:${b.panel}` : "panel.hide"]);
  return out;
}

export default class Coach extends View {
  init(_props, cx) {
    this.panel = props()?.view === "panel";
    this.showAll = false;
    this.confirmReset = false;
    if (this.panel) return;
    this.last = snap();
    this.keyAt = 0;
    this.toasted = {};
    // Routed shortcuts: note the key, then do what it's bound to.
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand();
        this.keyAt = Date.now();
        try {
          if (c.startsWith("panel:")) togglePanel(c.slice(6));
          else if (c === "panel.hide") run("layout.hide", { id: "panel" });
          else run(c, {});
        } catch (e) {
          notify({ title: `${c} failed`, body: String(e), level: "error" });
        }
      }
    });
  }

  // Runs on every render of the status copy: Herdr re-renders mods when
  // spaces, panes or the layout change, which is exactly when to look.
  watch() {
    const now = snap();
    const found = changes(this.last, now);
    this.last = now;
    if (!found.length || !routed()) return;
    const byKey = Date.now() - this.keyAt < KEY_WINDOW;
    // Scripts and agents act too; only count what happens while you're here.
    if (!byKey && !window()?.active) return;
    const stats = { ...(shared("coach.stats") ?? {}) };
    let day = shared("coach.today") ?? {};
    if (day.date !== today()) day = { date: today(), missed: 0 };
    for (const ids of found) {
      const id = ids.find((i) => keysFor(i).length) ?? ids[0];
      const keysNow = keysFor(id);
      const s = { used: 0, missed: 0, ...stats[id], at: Date.now() };
      if (byKey) s.used += 1;
      else {
        s.missed += 1;
        if (keysNow.length) day = { ...day, missed: day.missed + 1 };
        this.toast(id, keysNow, s);
      }
      stats[id] = s;
    }
    // Writing shared values re-renders everything; not from inside a render.
    Promise.resolve().then(() => {
      setShared("coach.stats", stats);
      setShared("coach.today", day);
    });
  }

  toast(id, keysNow, s) {
    if (!keysNow.length || shared("coach.muted")) return;
    if (Date.now() - (this.toasted[id] ?? 0) < COOLDOWN) return;
    this.toasted[id] = Date.now();
    const by = s.used ? `, ${s.used} by key` : "";
    Promise.resolve().then(() =>
      notify({
        title: keysNow.slice(0, 4).map(pretty).join("  "),
        body: `${label(id)} · by hand ${s.missed}×${by}`,
        level: "info",
        timeout: 3500,
      }),
    );
  }

  async bind(id, key) {
    const action = bindingFor(id);
    const name = section();
    await editKeys((all) => {
      // Coach's own commands only exist where coach is routed: this layout.
      if (!action.startsWith("coach."))
        all.global = { ...all.global, [key]: action };
      all[name] = {
        ...all[name],
        [key]: action.startsWith("coach.") ? action : `coach.${action}`,
      };
    });
    notify({
      title: pretty(key),
      body: `now does: ${label(id)}`,
      level: "success",
      timeout: 3500,
    });
  }

  render(cx) {
    if (!this.panel) this.watch();
    return this.panel ? this.list(cx) : this.chip();
  }

  // Status bar: today's count of things done by hand that had a key; opens the panel.
  chip() {
    const t = theme();
    const day = shared("coach.today");
    const n = day?.date === today() ? day.missed : 0;
    const on = routed();
    return h_flex()
      .size_full()
      .pr(14)
      .items_center()
      .justify_end()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .child(
        div()
          .id("coach-toggle")
          .cursor_pointer()
          .text_color(t.dim)
          .hover((s) => s.text_color(t.foreground))
          .tooltip(
            on
              ? "Hotkeys: what you did by hand today that has a key"
              : "Hotkeys: set up the keys to start coaching",
          )
          .on_click(openList)
          .child(
            !on ? "Hotkeys · set up" : n ? `Hotkeys · ${n} by hand` : "Hotkeys",
          ),
      );
  }

  list(cx) {
    const t = theme();
    const stats = shared("coach.stats") ?? {};
    const muted = Boolean(shared("coach.muted"));
    const on = routed();
    const taken = new Set(keys().map((k) => k.keys));
    const spare = SPARE.filter((k) => !taken.has(k));
    const rows = Object.entries(stats)
      .filter(([, s]) => s.missed > 0)
      .map(([id, s]) => ({ id, ...s, keys: keysFor(id) }))
      .sort((a, b) => b.missed - a.missed || b.at - a.at);
    const learn = rows.filter((r) => r.keys.length);
    const missing = rows.filter((r) => !r.keys.length);

    const chip = (k) =>
      div()
        .flex_none()
        .px(5)
        .h(18)
        .rounded(4)
        .bg(t.raised)
        .border_1()
        .border_color(t.border)
        .text_size(11)
        .text_color(t.foreground)
        .flex()
        .items_center()
        .child(pretty(k));

    const heading = (text, note) =>
      v_flex()
        .px(8)
        .pt(12)
        .pb(4)
        .gap(1)
        .flex_none()
        .child(div().font_medium().text_color(t.foreground).child(text))
        .child(div().text_size(11).text_color(t.dim).child(note));

    const learnRow = (r) => {
      const share = r.used / (r.used + r.missed);
      return v_flex()
        .px(8)
        .py(5)
        .gap(4)
        .flex_none()
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .child(
              h_flex()
                .gap(3)
                .flex_none()
                .children(r.keys.slice(0, 4).map(chip)),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12.5)
                .text_color(t.foreground)
                .child(label(r.id)),
            )
            .child(
              div()
                .flex_none()
                .text_size(11)
                .text_color(t.muted)
                .child(`${r.missed} by hand · ${r.used} by key`),
            ),
        )
        .child(
          // How much of it you already do by key.
          div()
            .h(3)
            .rounded(2)
            .bg(t.border)
            .child(
              div()
                .h(3)
                .rounded(2)
                .bg(t.done)
                .w(`${Math.round(share * 100)}%`),
            ),
        );
    };

    const missingRow = (r, i) =>
      h_flex()
        .px(8)
        .py(5)
        .gap(6)
        .items_center()
        .flex_none()
        .child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(12.5)
            .text_color(t.foreground)
            .child(label(r.id)),
        )
        .child(
          div()
            .flex_none()
            .text_size(11)
            .text_color(t.muted)
            .child(`${r.missed}×`),
        )
        .when(Boolean(spare[i]), (el) =>
          el.child(
            div()
              .id(`bind-${r.id}`)
              .flex_none()
              .px(6)
              .h(20)
              .rounded(5)
              .flex()
              .items_center()
              .gap(4)
              .cursor_pointer()
              .text_size(11)
              .text_color(t.accent)
              .hover((s) => s.bg(t.hover))
              .tooltip(`Bind ${pretty(spare[i])} to this (writes keys.json)`)
              .on_click(() => cx.spawn(() => this.bind(r.id, spare[i])))
              .child(`Bind ${pretty(spare[i])}`),
          ),
        );

    // Every shortcut, with the numbered ones folded into one line each.
    const sheet = () => {
      const groups = new Map();
      for (const k of keys().filter((k) => k.section === "global")) {
        const action = k.action.startsWith("coach.")
          ? k.action.slice(6)
          : k.action;
        const [name, value] = action.split(":");
        const numbered =
          /^(space|tab)\.select$/.test(name) && /^\d$/.test(value);
        const id = numbered
          ? name
          : (Object.keys(FAMILY).find((f) => action.startsWith(FAMILY[f])) ??
            action);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(numbered ? k.keys.replace(/\d$/, "1…9") : k.keys);
      }
      const named = {
        "space.select": "Go to space 1–9",
        "tab.select": "Go to tab 1–9",
      };
      return [...groups].map(([id, ks]) =>
        h_flex()
          .px(8)
          .py(3)
          .gap(6)
          .items_center()
          .flex_none()
          .child(
            h_flex()
              .gap(3)
              .flex_none()
              .children([...new Set(ks)].slice(0, 3).map(chip)),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(12)
              .text_color(t.muted)
              .child(named[id] ?? label(id)),
          ),
      );
    };

    const button = (id, text, onClick, color = t.dim) =>
      div()
        .id(id)
        .px(6)
        .rounded(5)
        .cursor_pointer()
        .text_size(11)
        .text_color(color)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(onClick)
        .child(text);

    return v_flex()
      .id("coach")
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .text_size(13)
      .child(
        h_flex()
          .px(12)
          .h(40)
          .flex_none()
          .items_center()
          .gap(4)
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .flex_1()
              .font_semibold()
              .text_color(t.foreground)
              .child("Hotkeys"),
          )
          .child(
            button("coach-mute", muted ? "Toasts off" : "Toasts on", () =>
              setShared("coach.muted", !muted),
            ),
          )
          .child(
            button(
              "coach-reset",
              this.confirmReset ? "Really reset?" : "Reset",
              (_e, cx) => {
                if (this.confirmReset) {
                  setShared("coach.stats", {});
                  setShared("coach.today", {});
                }
                this.confirmReset = !this.confirmReset;
                cx.notify();
              },
              this.confirmReset ? t.blocked : t.dim,
            ),
          )
          .child(
            button("coach-close", "×", () =>
              props()?.overlay
                ? closeOverlay(props().overlay)
                : run("layout.hide", { id: "panel" }),
            ),
          ),
      )
      .when(!on, (el) =>
        el.child(
          v_flex()
            .m(8)
            .p(10)
            .gap(8)
            .flex_none()
            .rounded(8)
            .border_1()
            .border_color(t.border)
            .bg(t.raised)
            .child(
              div()
                .text_size(12)
                .text_color(t.foreground)
                .child(
                  `Herdr can't tell a key from a click, so Hotkeys needs your shortcuts for moving around (spaces, tabs, panes, sidebar) to pass through it. Set up keys adds them to keys.json, in the "${section()}" section, for this layout only. They keep doing the same thing.`,
                ),
            )
            .child(
              div()
                .text_size(11)
                .text_color(t.dim)
                .child(
                  "While they're set up, changes to those defaults in Herdr updates won't reach this layout. Undo removes them again.",
                ),
            )
            .child(
              h_flex().child(
                button(
                  "coach-route",
                  "Set up keys",
                  () => cx.spawn(() => routeKeys()),
                  t.accent,
                ),
              ),
            ),
        ),
      )
      .child(
        v_flex()
          .id("coach-body")
          .flex_1()
          .min_h(0)
          .p(4)
          .overflow_y_scrollbar()
          .when(on && rows.length === 0, (el) =>
            el.child(
              div()
                .p(12)
                .text_size(12)
                .text_color(t.dim)
                .child(
                  "Nothing done by hand yet. Click around as usual: whenever there was a key for it, a toast shows it, and it lands here.",
                ),
            ),
          )
          .when(learn.length > 0, (el) =>
            el
              .child(
                heading(
                  "Learn these",
                  "Done by hand most, with the key that does it",
                ),
              )
              .children(learn.map(learnRow)),
          )
          .when(missing.length > 0, (el) =>
            el
              .child(
                heading(
                  "Could use a key",
                  "Done by hand, and nothing is bound to it",
                ),
              )
              .children(missing.map(missingRow)),
          )
          .child(
            h_flex()
              .id("coach-sheet")
              .px(8)
              .pt(12)
              .pb(4)
              .gap(6)
              .flex_none()
              .cursor_pointer()
              .on_click((_e, cx) => {
                this.showAll = !this.showAll;
                cx.notify();
              })
              .child(
                div()
                  .font_medium()
                  .text_color(t.foreground)
                  .child("Every shortcut"),
              )
              .child(
                div()
                  .text_size(11)
                  .text_color(t.dim)
                  .child(this.showAll ? "hide" : "show"),
              ),
          )
          .when(this.showAll, (el) => el.children(sheet()))
          .when(on, (el) =>
            el.child(
              h_flex()
                .px(4)
                .pt(16)
                .pb(8)
                .flex_none()
                .child(
                  button("coach-unroute", `Undo key setup (${section()})`, () =>
                    cx.spawn(() => unrouteKeys()),
                  ),
                ),
            ),
          ),
      );
  }
}
