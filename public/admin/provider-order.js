// Lets every [data-prov-list] on the page be reordered by dragging a row's
// grip, or with the arrow keys on it, then rewrites each priority input top
// to bottom (10, 20, 30, ...) so the saved order is the order on screen.
// Rows marked data-prov-off (disabled globally) keep their place but are
// never counted as tried. Ordinals match ORDINALS in src/ui/provider-order.tsx.
(() => {
  const ordinals = ["first", "second", "third", "fourth", "fifth"];
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
        item.querySelector("[data-prov-rank]").textContent = tried ? String(rank) : "\u2013";
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
