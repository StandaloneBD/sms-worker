/**
 * Single shared page shell ("Switchboard"): a top rail (brand, nav, admin /
 * sign-out), a max-width page column, and one inline <style> block. No
 * external assets besides the Google Fonts link, and no client-side JS
 * beyond /admin/confirm.js, which prompts before submitting any form with a
 * data-confirm attribute, /admin/expand.js, which opens and closes row
 * details, and /admin/provider-order.js on pages with a provider order
 * (the admin CSP forbids inline script).
 *
 * The CSS is injected via dangerouslySetInnerHTML: hono/jsx escapes text
 * children by default (including inside <style>, an HTML "raw text"
 * element the browser never re-decodes), which would corrupt any CSS using
 * & < > ' ". dangerouslySetInnerHTML bypasses that — see base.js's
 * toStringToBuffer, which special-cases the prop to `children = [raw(v.__html)]`
 * instead of running the string through escapeToBuffer.
 */

import type { FC, PropsWithChildren } from "hono/jsx";
import type { Flash } from "./flash";
import { adminPath } from "./paths";

export type NavKey = "dashboard" | "apps" | "providers" | "settings";

/** Global sections only: jobs and messages live under each App. */
const NAV_ITEMS: { key: NavKey; label: string; href: string }[] = [
  { key: "dashboard", label: "Overview", href: adminPath("/") },
  { key: "apps", label: "Apps", href: adminPath("/apps") },
  { key: "providers", label: "Providers", href: adminPath("/providers") },
  { key: "settings", label: "Settings", href: adminPath("/settings") },
];

const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap";

const CSS = `
:root {
  color-scheme: light;
  --ground: #EDF1EE;
  --panel: #FFFFFF;
  --ink: #14211C;
  --muted: #5C6B63;
  --line: #D3DAD5;
  --line-2: #E4E9E5;
  --accent: #0F6E56;
  --accent-ink: #0B4F3E;
  --accent-soft: #DDEFE8;
  --danger: #B42318;
  --danger-soft: #FBE9E7;
  --amber: #B7791F;
  --amber-soft: #FBF1DC;
  --row-open: #F6F8F7;
  /* Chart marks: a step more saturated than --accent / --danger so the pair
     clears the chroma floor and stays apart under deuteranopia. */
  --chart-sent: #138A68;
  --chart-failed: #C8321F;
  --focus: #0F6E56;
  --radius: 6px;
  --radius-panel: 10px;
  --shadow: 0 1px 0 rgba(20,33,28,.04), 0 1px 2px rgba(20,33,28,.06);
  --font-display: "Bricolage Grotesque", "IBM Plex Sans", system-ui, sans-serif;
  --font-body: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
}

* { box-sizing: border-box; }

html {
  background: var(--ground);
  -webkit-text-size-adjust: 100%;
}

body {
  margin: 0;
  font-family: var(--font-body);
  background: var(--ground);
  color: var(--ink);
  font-size: 14px;
  line-height: 1.5;
}

a {
  color: var(--accent);
  text-decoration: none;
}
a:hover { color: var(--accent-ink); text-decoration: underline; }

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

button {
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

input {
  font-family: inherit;
  font-size: 13px;
  color: var(--ink);
}

:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  * { animation-duration: .001ms !important; animation-iteration-count: 1 !important; }
}

/* ---------------------------------------------------------------- */
/* Top rail                                                          */
/* ---------------------------------------------------------------- */

.topbar {
  height: 52px;
  display: flex;
  align-items: stretch;
  gap: 24px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  padding: 0 32px;
}

.topbar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink);
  flex-shrink: 0;
}
.topbar-brand:hover { text-decoration: none; color: var(--ink); }
.topbar-brand svg { color: var(--accent); }
.topbar-brand span {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: .14em;
}

.topbar-nav {
  display: flex;
  align-items: stretch;
  gap: 4px;
  overflow-x: auto;
  flex: 1;
}

.topbar-nav a {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 12px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  box-sizing: border-box;
}
.topbar-nav a:hover { color: var(--ink); text-decoration: none; }
.topbar-nav a.is-active {
  color: var(--ink);
  border-bottom-color: var(--accent);
}

.topbar-user {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
.topbar-user .mono { font-size: 12px; line-height: 1; }
.topbar-user form { margin: 0; display: flex; }

/* ---------------------------------------------------------------- */
/* Page                                                               */
/* ---------------------------------------------------------------- */

.page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 28px 32px 64px;
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 20px;
}

.eyebrow {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: .12em;
  color: var(--muted);
  margin: 0 0 6px;
}

.page-title {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 600;
  letter-spacing: -.02em;
  margin: 0;
  color: var(--ink);
}

.page-sub {
  font-size: 13px;
  color: var(--muted);
  margin: 8px 0 0;
  max-width: 60ch;
}

.page-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* ---------------------------------------------------------------- */
/* Flash                                                              */
/* ---------------------------------------------------------------- */

.flash {
  padding: 10px 14px;
  border-radius: var(--radius);
  margin-bottom: 20px;
  font-size: 13px;
  border: 1px solid transparent;
}
.flash-success { background: var(--accent-soft); color: var(--accent-ink); border-color: var(--accent-soft); }
.flash-error { background: var(--danger-soft); color: var(--danger); border-color: var(--danger-soft); }

/* ---------------------------------------------------------------- */
/* Panel                                                              */
/* ---------------------------------------------------------------- */

.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow);
  margin-bottom: 20px;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--line-2);
}

.panel-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-body { padding: 20px; }
.panel-body.panel-flush { padding: 0; }

.panel-foot {
  padding: 16px 20px;
  border-top: 1px solid var(--line-2);
}

/* ---------------------------------------------------------------- */
/* Stats                                                              */
/* ---------------------------------------------------------------- */

.stat-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 16px;
  margin-bottom: 20px;
}

.stat {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow);
  padding: 16px 18px;
}

.stat-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  margin: 0 0 8px;
}

.stat-value {
  font-family: var(--font-display);
  font-size: 34px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  margin: 0;
  color: var(--ink);
}

.stat-sub {
  font-size: 12px;
  color: var(--muted);
  margin: 6px 0 0;
}

.ratio {
  display: flex;
  height: 4px;
  border-radius: 2px;
  overflow: hidden;
  background: var(--line-2);
  margin-top: 10px;
}
.ratio > span:first-child { background: var(--accent); }
.ratio > span:last-child { background: var(--danger); }

/* ---------------------------------------------------------------- */
/* Tables                                                             */
/* ---------------------------------------------------------------- */

.table-wrap { overflow-x: auto; }

table.data { width: 100%; }
table.data th,
table.data td {
  text-align: left;
  padding: 10px 20px;
  border-bottom: 1px solid var(--line-2);
  vertical-align: middle;
  white-space: nowrap;
}
table.data th {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--muted);
}
table.data tbody tr:last-child td { border-bottom: none; }
table.data tbody tr:hover { background: var(--ground); }
table.data td.num,
table.data th.num { text-align: right; }
table.data td.cell-clip { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
table.data td.cell-wrap { white-space: normal; min-width: 320px; max-width: 640px; overflow-wrap: anywhere; }

/* Messages: each message is its own <tbody> — a summary row, then a detail
   row (text, reason, job, length, tracking ID) its chevron opens. The detail
   spans every column, so long text never widens the table. */
table.data tbody.msg:last-child tr.msg-summary td,
table.data tbody.msg:has([aria-expanded="true"]) tr.msg-summary td { border-bottom: none; }
table.data tbody.msg tr:hover { background: none; }
table.data tbody.msg:hover,
table.data tbody.msg:has([aria-expanded="true"]) { background: var(--row-open); }
table.data tbody.msg tr.msg-detail td {
  white-space: normal;
  padding-top: 2px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--line-2);
}
table.data tbody.msg:last-child tr.msg-detail td { border-bottom: none; }
table.data td.msg-expand-cell { width: 1%; padding-left: 0; padding-right: 12px; text-align: right; }

.msg-expand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: var(--muted);
}
.msg-expand:hover { background: var(--panel); border-color: var(--line); color: var(--ink); }
.msg-expand svg { transition: transform .15s ease; }
.msg-expand[aria-expanded="true"] { color: var(--accent); }
.msg-expand[aria-expanded="true"] svg { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) {
  .msg-expand svg { transition: none; }
}

.msg-text-body {
  margin: 0 0 6px;
  max-width: 72ch;
  padding-left: 10px;
  border-left: 2px solid var(--line);
  font-size: 13px;
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.msg-reason {
  margin: 0 0 6px;
  padding-left: 12px;
  max-width: 72ch;
  font-size: 12px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.msg-reason.is-failed { color: var(--danger); }

.msg-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 28px;
  margin: 10px 0 0;
  padding-left: 12px;
  font-size: 12px;
}
.msg-facts > div { display: flex; gap: 8px; min-width: 0; }
.msg-facts dt { color: var(--muted); }
.msg-facts dd { margin: 0; font-family: var(--font-mono); overflow-wrap: anywhere; }
.msg-facts .segments { color: var(--ink); }

.num { font-variant-numeric: tabular-nums; }
.mono { font-family: var(--font-mono); }
.muted { color: var(--muted); }

.row-link {
  color: inherit;
}
.row-link:hover { color: var(--accent); text-decoration: none; }

/* ---------------------------------------------------------------- */
/* LED status                                                        */
/* ---------------------------------------------------------------- */

.led {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  vertical-align: middle;
  margin-right: 8px;
  box-shadow: 0 0 0 1px rgba(0,0,0,.08);
}
.led-accent { background: var(--accent); box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 0 0 3px var(--accent-soft); }
.led-danger { background: var(--danger); box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 0 0 3px var(--danger-soft); }
.led-amber { background: var(--amber); box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 0 0 3px var(--amber-soft); }
.led-warn { background: var(--amber); box-shadow: 0 0 0 1px var(--danger), 0 0 0 3px var(--danger-soft); }

.led-running { animation: led-pulse 1.4s ease-in-out infinite; }
@keyframes led-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .45; }
}
@media (prefers-reduced-motion: reduce) {
  .led-running { animation: none; }
}

.status {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
}

/* ---------------------------------------------------------------- */
/* Chunk progress                                                    */
/* ---------------------------------------------------------------- */

.chunks {
  display: inline-block;
  width: 120px;
  height: 8px;
  border-radius: 4px;
  background: var(--line-2);
  overflow: hidden;
  vertical-align: middle;
}
.chunks-fill {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
}
.chunks.chunks-seg {
  width: auto;
  height: 8px;
  background: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.chunks-seg i {
  display: inline-block;
  width: 6px;
  height: 8px;
  border-radius: 2px;
  background: var(--line-2);
  font-style: normal;
}
.chunks-seg i.is-done { background: var(--accent); }

.segments { font-size: 12px; }

/* ---------------------------------------------------------------- */
/* Forms                                                              */
/* ---------------------------------------------------------------- */

.form { max-width: 640px; }

.form-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  flex: 1 1 160px;
}

.field-narrow { max-width: 420px; }

.field label {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  margin-bottom: 6px;
}

.input,
.select {
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  font-family: var(--font-body);
}
.input.mono,
.select.mono { font-family: var(--font-mono); }

textarea.input { height: auto; padding: 8px 10px; }

.input:focus-visible,
.select:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.check {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}

.hint {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  margin: 8px 0 0;
}

/* ---------------------------------------------------------------- */
/* Buttons                                                            */
/* ---------------------------------------------------------------- */

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
}
.btn:hover { background: var(--ground); text-decoration: none; }

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn-primary:hover { background: var(--accent-ink); border-color: var(--accent-ink); color: #fff; }

.btn-danger {
  background: var(--panel);
  border-color: var(--danger);
  color: var(--danger);
}
.btn-danger:hover { background: var(--danger); border-color: var(--danger); color: #fff; }

.btn-quiet {
  background: none;
  border-color: transparent;
  color: var(--muted);
}
.btn-quiet:hover { background: var(--ground); color: var(--ink); }

.btn-sm { height: 26px; padding: 0 10px; font-size: 12px; }

/* ---------------------------------------------------------------- */
/* Badges                                                             */
/* ---------------------------------------------------------------- */

.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  border: 1px solid var(--line);
  background: var(--ground);
  color: var(--muted);
}
.badge-on { background: var(--accent-soft); border-color: var(--accent-soft); color: var(--accent-ink); }
.badge-off { background: var(--danger-soft); border-color: var(--danger-soft); color: var(--danger); }

/* ---------------------------------------------------------------- */
/* Key reveal                                                         */
/* ---------------------------------------------------------------- */

.key-reveal {
  font-family: var(--font-mono);
  font-size: 15px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-soft);
  border-radius: var(--radius);
  padding: 14px 16px;
  word-break: break-all;
  margin: 16px 0;
  color: var(--accent-ink);
}

/* ---------------------------------------------------------------- */
/* Breadcrumb, empty, kv, pagination                                 */
/* ---------------------------------------------------------------- */

.breadcrumb {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 8px;
}
.breadcrumb a { color: var(--muted); }
.breadcrumb a:hover { color: var(--accent); }

.empty {
  text-align: center;
  color: var(--muted);
  padding: 48px 20px;
}
.empty p { margin: 0 0 6px; }
.empty p:last-child { margin-bottom: 0; }

.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px 24px;
  margin: 0;
}
.kv dt {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: .08em;
  color: var(--muted);
  margin: 0 0 4px;
}
.kv dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-size: 13px;
  color: var(--ink);
}

.pagination {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

/* ---------------------------------------------------------------- */
/* Switch                                                             */
/* ---------------------------------------------------------------- */

.switch-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  flex-shrink: 0;
  width: 30px;
  height: 18px;
  margin: 0;
  border-radius: 999px;
  background: var(--line);
  cursor: pointer;
  transition: background-color .15s ease;
}
.switch::before {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(20,33,28,.25);
  transition: transform .15s ease;
}
.switch:checked { background: var(--accent); }
.switch:checked::before { transform: translateX(12px); }

@media (prefers-reduced-motion: reduce) {
  .switch, .switch::before { transition: none; }
}

/* ---------------------------------------------------------------- */
/* Provider lines                                                     */
/* ---------------------------------------------------------------- */

.prov-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.prov {
  display: grid;
  grid-template-columns: auto 200px minmax(0, 1fr);
  gap: 0 24px;
  padding: 22px 24px 24px 20px;
  border-bottom: 1px solid var(--line-2);
  /* Opaque so rows sliding past each other while reordering don't show through. */
  position: relative;
  background: var(--panel);
}
.prov:first-child { border-radius: var(--radius-panel) var(--radius-panel) 0 0; }
.prov:last-child { border-bottom: none; }

.prov-slot {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}

.prov-rank {
  min-width: 44px;
  font-family: var(--font-display);
  font-size: 44px;
  font-weight: 600;
  line-height: .9;
  letter-spacing: -.04em;
  font-variant-numeric: tabular-nums;
  color: var(--accent);
  text-align: center;
}

.prov-ident {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
}

.prov-name {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -.01em;
  line-height: 1.1;
  margin: 0;
}

.prov-order {
  font-size: 12px;
  color: var(--muted);
  margin: -8px 0 2px;
}

.prov-priority {
  display: flex;
  align-items: center;
  gap: 10px;
}
.prov-priority label { font-size: 12px; font-weight: 500; color: var(--muted); }
.prov-priority .input { width: 72px; }

/* Drag to reorder: only once /admin/providers.js has taken over the priority inputs. */
.prov-handle {
  display: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 40px;
  padding: 0;
  border: none;
  border-radius: var(--radius);
  background: none;
  color: var(--line);
  cursor: grab;
  touch-action: none;
}
.prov-handle:hover,
.prov-handle:focus-visible { color: var(--muted); background: var(--ground); }

.is-sortable .prov-handle { display: inline-flex; }
.is-sortable .prov-priority,
.is-sortable .prov-hint-manual,
.prov-hint-sortable { display: none; }
.is-sortable .prov-hint-sortable { display: inline; }

.prov.is-dragging {
  z-index: 1;
  box-shadow: inset 3px 0 0 var(--accent), 0 8px 24px rgba(20,33,28,.12);
}
.prov.is-dragging .prov-handle { color: var(--accent); background: var(--accent-soft); }
.is-reordering,
.is-reordering .prov-handle { cursor: grabbing; user-select: none; }

.prov-fields {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px 20px;
  align-content: start;
  transition: opacity .15s ease;
}
/* The key always sits in the last column so it lines up across providers. */
.prov-fields .prov-key { grid-column: -2; }
.prov-fields .field label { margin-bottom: 0; }
.prov-fields .field > label,
.prov-key-head { margin-bottom: 6px; }

.prov-key-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  height: 18px;
}
.prov-key-head .badge { padding: 0 8px; font-size: 11px; line-height: 18px; }

.prov-key-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}
.prov-key-foot label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-weight: 400;
  cursor: pointer;
}
.prov-key-foot .check { width: 14px; height: 14px; margin: 0; }

/* A disabled line recedes, both as saved and the moment it is switched off. */
.prov:has(.switch:not(:checked)) .prov-rank { color: var(--line); }
.prov:has(.switch:not(:checked)) .prov-fields { opacity: .55; }

.prov-dirty { color: var(--amber); font-weight: 500; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.prov-foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 16px;
  font-size: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .prov-fields { transition: none; }
}

@media (max-width: 860px) {
  .prov {
    grid-template-columns: auto minmax(0, 1fr);
    gap: 18px 16px;
    padding: 20px 16px;
  }
  .prov-rank { font-size: 34px; min-width: 32px; }
  .prov-ident {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 20px;
  }
  .prov-name { flex-basis: 100%; }
  .prov-order { flex-basis: 100%; margin: -6px 0 0; }
  .prov-fields { grid-column: 1 / -1; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .prov-fields .prov-key { grid-column: auto; }
}

/* Off on the Providers page: never tried, whatever this list says. */
.prov[data-prov-off] .prov-rank { color: var(--line); }
.prov[data-prov-off] .prov-name { color: var(--muted); }

/* Compact lines (an App's provider plan): no credential fields, so name and
   controls share one row at every width. */
.prov-list.is-compact .prov {
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0 20px;
  padding: 14px 20px 14px 16px;
}
.prov-list.is-compact .prov-slot { align-items: center; }
.prov-list.is-compact .prov-rank { font-size: 30px; min-width: 36px; }
.prov-list.is-compact .prov-ident { flex-direction: column; align-items: flex-start; gap: 2px; }
.prov-list.is-compact .prov-name { font-size: 16px; flex-basis: auto; }
.prov-list.is-compact .prov-order { margin: 0; flex-basis: auto; }
.prov-list.is-compact .prov-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px 20px;
}

/* ---------------------------------------------------------------- */
/* App header + tabs                                                 */
/* ---------------------------------------------------------------- */

.app-head {
  margin: -4px 0 24px;
  border-bottom: 1px solid var(--line);
}

.app-head-main {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 14px;
}

.app-head-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 14px;
  min-width: 0;
}
.app-head-title .page-title { overflow-wrap: anywhere; }
.app-head-title .badge { align-self: center; }

.app-head-back {
  flex-basis: 100%;
  font-size: 12px;
  color: var(--muted);
}
.app-head-back:hover { color: var(--accent); text-decoration: none; }

.app-head-trail { color: var(--muted); font-weight: 500; }

.tabs {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  margin-bottom: -1px;
}
.tabs a {
  padding: 8px 12px 10px;
  font-size: 14px;
  font-weight: 500;
  color: var(--muted);
  white-space: nowrap;
  border-bottom: 2px solid transparent;
}
.tabs a:first-child { padding-left: 0; }
.tabs a:hover { color: var(--ink); text-decoration: none; }
.tabs a.is-active { color: var(--ink); border-bottom-color: var(--accent); }

/* In-page section links (an App's configuration). */
.jump {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  margin: -8px 0 18px;
  font-size: 12px;
}
.jump a { color: var(--muted); }
.jump a:hover { color: var(--accent); }
.panel[id] { scroll-margin-top: 16px; }

/* Segmented filter (All / Failed). */
.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}
.seg a {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
}
.seg a + a { border-left: 1px solid var(--line); }
.seg a:hover { color: var(--ink); background: var(--ground); text-decoration: none; }
.seg a.is-active { background: var(--accent-soft); color: var(--accent-ink); }

.app-link { font-weight: 600; color: var(--ink); }
.app-link:hover { color: var(--accent); }
.badge-inline { margin-left: 10px; padding: 0 8px; font-size: 11px; }

.panel-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  margin-bottom: 20px;
}
.panel-pair > .panel { margin-bottom: 0; }
.panel-note { margin: 0; font-size: 13px; }
@media (max-width: 860px) {
  .panel-pair { grid-template-columns: minmax(0, 1fr); }
}

/* ---------------------------------------------------------------- */
/* Charts                                                             */
/* ---------------------------------------------------------------- */

.vol { margin: 0; }

.vol-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin-bottom: 18px;
  font-size: 13px;
  color: var(--muted);
}
.vol-key { display: inline-flex; align-items: center; gap: 8px; }
.vol-key strong { color: var(--ink); font-weight: 600; }
.vol-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }

.vol-sent { background: var(--chart-sent); }
.vol-failed { background: var(--chart-failed); }

.vol-frame {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0 10px;
}

.vol-axis {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 200px;
  font-size: 11px;
  color: var(--muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.vol-axis span { height: 0; display: flex; align-items: center; justify-content: flex-end; }

.vol-plot { min-width: 0; }

.vol-cols {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 200px;
  margin: 0;
  padding: 0;
  list-style: none;
  /* Gridlines at the top and middle ticks; the baseline is the border. */
  background:
    linear-gradient(var(--line-2), var(--line-2)) 0 0 / 100% 1px no-repeat,
    linear-gradient(var(--line-2), var(--line-2)) 0 50% / 100% 1px no-repeat;
  border-bottom: 1px solid var(--line);
}

.vol-col {
  flex: 1 1 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  border-radius: 4px 4px 0 0;
}
.vol-col:hover { background: var(--row-open); }

.vol-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: min(24px, 70%);
}
.vol-stack > span { flex-basis: 0; min-height: 2px; }
.vol-stack > :first-child { border-radius: 4px 4px 0 0; }

.vol-days {
  display: flex;
  gap: 2px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.vol-days li { flex: 1 1 0; text-align: center; white-space: nowrap; }
.vol-days li:first-child { text-align: left; }
.vol-days li.is-today { text-align: right; color: var(--ink); font-weight: 500; }
@media (max-width: 720px) {
  /* Too narrow for a label per day: keep every fourth, and today. */
  .vol-days li:not(:nth-child(4n+1)):not(.is-today),
  .vol-days li:nth-last-child(2) { visibility: hidden; }
}

/* Sparkline: the same columns, cell-sized. */
.vol-cols.vol-spark {
  width: 112px;
  height: 26px;
  gap: 1px;
  background: none;
  border-bottom-color: var(--line-2);
}
.vol-spark .vol-col { border-radius: 0; }
.vol-spark .vol-stack { width: 100%; gap: 1px; }
.vol-spark .vol-stack > span { min-height: 1px; }
.vol-spark .vol-stack > :first-child { border-radius: 1px 1px 0 0; }

/* Horizontal share bars (providers). */
.share { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }
.share-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  font-size: 13px;
}
.share-label { font-weight: 500; overflow-wrap: anywhere; }
.share-track { height: 10px; }
.share-bar { display: flex; gap: 2px; height: 100%; }
.share-bar > span { flex-basis: 0; min-width: 2px; }
.share-bar > :last-child { border-radius: 0 3px 3px 0; }
.share-value { text-align: right; white-space: nowrap; }
.share-value .muted { font-size: 12px; }

/* Failure reasons, most common first. */
.reasons { list-style: none; margin: 0; padding: 0; font-size: 13px; }
.reasons li {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--line-2);
}
.reasons li:first-child { padding-top: 0; }
.reasons li:last-child { border-bottom: none; padding-bottom: 0; }
.reasons-count { font-weight: 600; text-align: right; }
.reasons-text { overflow-wrap: anywhere; }

/* Quota meter: the track is a lighter step of the fill. */
.meter {
  height: 4px;
  border-radius: 2px;
  background: var(--accent-soft);
  margin-top: 10px;
  overflow: hidden;
}
.meter > span { display: block; height: 100%; background: var(--accent); }
.meter.is-high { background: var(--amber-soft); }
.meter.is-high > span { background: var(--amber); }

/* ---------------------------------------------------------------- */
/* Login shell                                                       */
/* ---------------------------------------------------------------- */

.login-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.login-panel {
  width: 380px;
  max-width: 100%;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow);
  padding: 28px;
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
  color: var(--ink);
}
.login-brand svg { color: var(--accent); }
.login-brand span {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: .14em;
}

/* ---------------------------------------------------------------- */
/* Responsive                                                        */
/* ---------------------------------------------------------------- */

@media (max-width: 720px) {
  .topbar { padding: 0 16px; gap: 16px; }
  .page { padding: 16px 16px 48px; }
  .page-head,
  .app-head-main { flex-direction: column; align-items: flex-start; }
  .share-row { grid-template-columns: 80px minmax(0, 1fr); }
  .share-value { grid-column: 2; text-align: left; margin-top: -8px; }
  .topbar-nav { flex-wrap: nowrap; }
}
`;

/** Without /admin/expand.js the toggles do nothing, so show every detail row. */
const NOSCRIPT_CSS = "tr.msg-detail[hidden] { display: table-row; } .msg-expand { visibility: hidden; }";

function BrandGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1" y="9" width="3" height="6" rx="1" fill="currentColor" />
      <rect x="6.5" y="5" width="3" height="10" rx="1" fill="currentColor" />
      <rect x="12" y="1" width="3" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

function Head({ title }: { title: string }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title} · SMS Worker Admin</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
      <link rel="stylesheet" href={FONTS_HREF} />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <script src={adminPath("/confirm.js")} defer />
      <script src={adminPath("/expand.js")} defer />
      <noscript>
        <style dangerouslySetInnerHTML={{ __html: NOSCRIPT_CSS }} />
      </noscript>
    </head>
  );
}

interface LayoutProps {
  title: string;
  active?: NavKey;
  flash?: Flash;
  adminName?: string;
}

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({ title, active, flash, adminName, children }) => {
  return (
    <html lang="en">
      <Head title={title} />
      <body>
        <div class="topbar">
          <a class="topbar-brand" href={adminPath("/")}>
            <BrandGlyph />
            <span>SMS WORKER</span>
          </a>
          <nav class="topbar-nav">
            {NAV_ITEMS.map((item) => (
              <a href={item.href} class={active === item.key ? "is-active" : undefined}>
                {item.label}
              </a>
            ))}
          </nav>
          <div class="topbar-user">
            {adminName ? <span class="mono muted">{adminName}</span> : null}
            <form method="post" action={adminPath("/logout")}>
              <button type="submit" class="btn btn-quiet btn-sm">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <div class="page">
          {flash ? <div class={`flash flash-${flash.type}`}>{flash.message}</div> : null}
          {children}
        </div>
      </body>
    </html>
  );
};

interface LoginShellProps {
  title: string;
  flash?: Flash;
}

export const LoginShell: FC<PropsWithChildren<LoginShellProps>> = ({ title, flash, children }) => {
  return (
    <html lang="en">
      <Head title={title} />
      <body>
        <div class="login-shell">
          <div class="login-panel">
            <div class="login-brand">
              <BrandGlyph />
              <span>SMS WORKER</span>
            </div>
            {flash ? <div class={`flash flash-${flash.type}`}>{flash.message}</div> : null}
            {children}
          </div>
        </div>
      </body>
    </html>
  );
};
