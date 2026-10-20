/**
 * Ordered provider lists, shared by the global Providers page and an App's
 * provider plan: both are a priority order (lowest first) over enabled
 * providers, edited by dragging rows. The list markup is server-rendered with
 * a visible priority input per row; PROVIDER_ORDER_SCRIPT (served at
 * /admin/provider-order.js — the admin CSP forbids inline script) hides those
 * inputs and rewrites them from the on-screen order instead.
 */

import type { Child } from "hono/jsx";
import type { ProviderName } from "../shared/types";
import { adminPath } from "./paths";

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  bulksmsbd: "BulkSMSBD",
  mimsms: "MimSms",
};

const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

/**
 * Lets every [data-prov-list] on the page be reordered by dragging a row's
 * grip, or with the arrow keys on it, then rewrites each priority input top
 * to bottom (10, 20, 30, ...) so the saved order is the order on screen.
 * Rows marked data-prov-off (disabled globally) keep their place but are
 * never counted as tried.
 */
export const PROVIDER_ORDER_SCRIPT = `(() => {
  const ordinals = ${JSON.stringify(ORDINALS)};
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

  for (const list of document.querySelectorAll("[data-prov-list]")) {
    const form = list.closest("form");
    const live = form.querySelector("[data-prov-live]");
    const dirty = form.querySelector("[data-prov-dirty]");
    const items = () => [...list.querySelectorAll("[data-prov]")];

    const renumber = () => {
      let rank = 0;
      const all = items();
      all.forEach((item, i) => {
        const off = item.hasAttribute("data-prov-off");
        const tried = !off && item.querySelector("[data-prov-enabled]").checked;
        if (tried) rank += 1;
        item.querySelector("[data-prov-priority]").value = String((i + 1) * 10);
        item.querySelector("[data-prov-rank]").textContent = tried ? String(rank) : "\\u2013";
        if (!off) item.querySelector("[data-prov-order]").textContent = tried ? "Tried " + (ordinals[rank - 1] || "#" + rank) : "Not tried";
        item.querySelector("[data-prov-handle]").setAttribute("aria-label", "Move " + item.dataset.prov + ", position " + (i + 1) + " of " + all.length);
      });
    };

    // Moves an item and slides the rows it displaced into place (FLIP).
    const move = (item, before) => {
      const tops = new Map(items().map((el) => [el, el.getBoundingClientRect().top]));
      list.insertBefore(item, before);
      if (!reduceMotion.matches) {
        for (const el of items()) {
          const delta = tops.get(el) - el.getBoundingClientRect().top;
          if (delta) el.animate([{ transform: "translateY(" + delta + "px)" }, { transform: "none" }], { duration: 160, easing: "ease-out" });
        }
      }
      renumber();
      if (dirty) dirty.hidden = false;
    };

    const announce = (item) => {
      if (live) live.textContent = item.dataset.prov + " moved to position " + (items().indexOf(item) + 1) + " of " + items().length + ".";
    };

    list.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest("[data-prov-handle]");
      if (!handle || event.button !== 0) return;
      event.preventDefault();
      const item = handle.closest("[data-prov]");
      const start = items().indexOf(item);
      handle.setPointerCapture(event.pointerId);
      item.classList.add("is-dragging");
      list.classList.add("is-reordering");

      const onMove = (e) => {
        for (const other of items()) {
          if (other === item) continue;
          const r = other.getBoundingClientRect();
          if (e.clientY < r.top || e.clientY > r.bottom) continue;
          const below = items().indexOf(other) > items().indexOf(item);
          if (below && e.clientY > r.top + r.height / 2) move(item, other.nextElementSibling);
          else if (!below && e.clientY < r.top + r.height / 2) move(item, other);
          break;
        }
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        item.classList.remove("is-dragging");
        list.classList.remove("is-reordering");
        if (items().indexOf(item) !== start) announce(item);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });

    list.addEventListener("keydown", (event) => {
      const handle = event.target.closest("[data-prov-handle]");
      if (!handle || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
      event.preventDefault();
      const item = handle.closest("[data-prov]");
      const target = event.key === "ArrowUp" ? item.previousElementSibling : item.nextElementSibling;
      if (!target) return;
      move(item, event.key === "ArrowUp" ? target : target.nextElementSibling);
      handle.focus();
      announce(item);
    });

    list.addEventListener("change", (event) => {
      if (event.target.matches("[data-prov-enabled]")) renumber();
    });

    form.classList.add("is-sortable");
    renumber();
  }
})();
`;

/**
 * Hands out display ranks while rendering rows in priority order: only
 * providers that will actually be tried get a number.
 */
export function rankCounter() {
  let rank = 0;
  return (tried: boolean): number | null => (tried ? ++rank : null);
}

function GripIcon() {
  return (
    <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="3" r="1.5" />
      <circle cx="9" cy="3" r="1.5" />
      <circle cx="3" cy="9" r="1.5" />
      <circle cx="9" cy="9" r="1.5" />
      <circle cx="3" cy="15" r="1.5" />
      <circle cx="9" cy="15" r="1.5" />
    </svg>
  );
}

/** Drag grip and rank numeral: the first cell of a provider row. */
export function ProviderSlot({ rank }: { rank: number | null }) {
  return (
    <div class="prov-slot">
      <button type="button" class="prov-handle" data-prov-handle>
        <GripIcon />
      </button>
      <span class="prov-rank" aria-hidden="true" data-prov-rank>
        {rank ?? "–"}
      </span>
    </div>
  );
}

/** Provider name and where it falls in the order. */
export function ProviderTitle({
  provider,
  rank,
  globallyOff,
}: {
  provider: ProviderName;
  rank: number | null;
  globallyOff?: boolean;
}) {
  return (
    <>
      <h2 class="prov-name">{PROVIDER_LABELS[provider]}</h2>
      <p class="prov-order" data-prov-order>
        {globallyOff ? (
          <>
            Disabled on the <a href={adminPath("/providers")}>Providers</a> page
          </>
        ) : rank !== null ? (
          `Tried ${ORDINALS[rank - 1] ?? `#${rank}`}`
        ) : (
          "Not tried"
        )}
      </p>
    </>
  );
}

export function EnabledSwitch({ provider, checked }: { provider: ProviderName; checked: boolean }) {
  return (
    <label class="switch-label">
      <input class="switch" type="checkbox" name={`${provider}_enabled`} value="on" checked={checked} data-prov-enabled />
      Enabled
    </label>
  );
}

/** The no-JS fallback; hidden once PROVIDER_ORDER_SCRIPT owns the order. */
export function PriorityField({ provider, priority }: { provider: ProviderName; priority: number }) {
  const id = `${provider}-priority`;
  return (
    <div class="prov-priority">
      <label for={id}>Priority</label>
      <input
        class="input num"
        type="number"
        min={1}
        id={id}
        name={`${provider}_priority`}
        value={String(priority)}
        data-prov-priority
      />
    </div>
  );
}

/** Save button and order hints under a provider list, plus its screen-reader announcer. */
export function ProviderOrderFoot({ saveLabel, note }: { saveLabel: string; note?: Child }) {
  return (
    <>
      <div class="panel-foot prov-foot">
        <button type="submit" class="btn btn-primary">
          {saveLabel}
        </button>
        <span class="prov-dirty" data-prov-dirty hidden>
          New order not saved yet.
        </span>
        <span class="muted prov-hint-manual">Lower priority is tried first. Disabled providers are skipped.</span>
        <span class="muted prov-hint-sortable">
          Drag rows to change the order they're tried in. Disabled providers are skipped.
        </span>
        {note ? <span class="muted">{note}</span> : null}
      </div>
      <p class="sr-only" aria-live="polite" data-prov-live />
    </>
  );
}

export function ProviderOrderScript() {
  return <script src={adminPath("/provider-order.js")} defer />;
}
