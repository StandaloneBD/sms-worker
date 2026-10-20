/**
 * Single shared page shell ("Switchboard"): a top rail (brand, nav, admin /
 * sign-out), a max-width page column, and one inline <style> block. No
 * external assets besides the Google Fonts link, and no client-side JS
 * beyond /admin/confirm.js, which prompts before submitting any form with a
 * data-confirm attribute (the admin CSP forbids inline script).
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

export type NavKey = "dashboard" | "jobs" | "messages" | "apps" | "providers" | "settings";

const NAV_ITEMS: { key: NavKey; label: string; href: string }[] = [
  { key: "dashboard", label: "Overview", href: adminPath("/") },
  { key: "jobs", label: "Jobs", href: adminPath("/jobs") },
  { key: "messages", label: "Messages", href: adminPath("/messages") },
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
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: .12em;
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
  .page-head { flex-direction: column; align-items: flex-start; }
  .topbar-nav { flex-wrap: nowrap; }
}
`;

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
