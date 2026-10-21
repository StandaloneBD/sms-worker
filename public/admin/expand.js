// Disclosure buttons: a [data-expand] button shows/hides the element its
// aria-controls names (a message's detail row). The details render hidden;
// the shell's <noscript> style reveals them when this can't run.
document.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-expand]") : null;
  const target = button && document.getElementById(button.getAttribute("aria-controls"));
  if (!target) return;
  const open = button.getAttribute("aria-expanded") !== "true";
  button.setAttribute("aria-expanded", String(open));
  target.hidden = !open;
});
