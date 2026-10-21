/**
 * Ordered provider lists, shared by the global Providers page and an App's
 * provider plan: both are a priority order (lowest first) over enabled
 * providers, edited by dragging rows. The list markup is server-rendered with
 * a visible priority input per row; public/admin/provider-order.js (a static
 * asset — the admin CSP forbids inline script) hides those inputs and
 * rewrites them from the on-screen order instead.
 */

import type { Child } from "hono/jsx";
import type { ProviderName } from "../shared/types";
import { adminPath } from "./paths";

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  bulksmsbd: "BulkSMSBD",
  mimsms: "MimSms",
};

// Also in public/admin/provider-order.js, which relabels rows after a drag.
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];

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

/** The no-JS fallback; hidden once /admin/provider-order.js owns the order. */
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
