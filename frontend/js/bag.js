/**
 * The box. Frosted Corner's bag is a physical pink dessert box: it opens on a
 * hinge, holds six slots, and items land in a slot when you add them.
 *
 * State lives here; the rest of the app subscribes through `onChange`.
 */

const BOX_CAPACITY = 6;

const state = {
  lines: [], // { item, qty }
  open: false
};

const listeners = new Set();

const totalCount = () => state.lines.reduce((sum, line) => sum + line.qty, 0);
const subtotal = () => state.lines.reduce((sum, line) => sum + line.qty * line.item.price, 0);

function emit() {
  const snapshot = {
    lines: state.lines.map((line) => ({ ...line })),
    count: totalCount(),
    subtotal: subtotal(),
    capacity: BOX_CAPACITY,
    open: state.open
  };
  listeners.forEach((fn) => fn(snapshot));
}

export function onChange(fn) {
  listeners.add(fn);
  emit();
  return () => listeners.delete(fn);
}

export function add(item, qty = 1) {
  const existing = state.lines.find((line) => line.item.id === item.id);
  if (existing) existing.qty += qty;
  else state.lines.push({ item, qty });
  emit();
}

export function remove(itemId) {
  const index = state.lines.findIndex((line) => line.item.id === itemId);
  if (index === -1) return;
  const line = state.lines[index];
  line.qty -= 1;
  if (line.qty <= 0) state.lines.splice(index, 1);
  emit();
}

export function clear() {
  state.lines = [];
  emit();
}

export function setOpen(open) {
  state.open = open;
  emit();
}

export function toggle() {
  setOpen(!state.open);
}

export const getCount = totalCount;

export function snapshot() {
  return {
    lines: state.lines.map((line) => ({ ...line })),
    count: totalCount(),
    subtotal: subtotal(),
    capacity: BOX_CAPACITY,
    open: state.open
  };
}

/**
 * Flattens line items into individual units so the box can show one tile per
 * treat, capped at the visible capacity.
 */
export function slots() {
  const units = [];
  state.lines.forEach((line) => {
    for (let i = 0; i < line.qty; i += 1) units.push(line.item);
  });
  return units;
}

/* ------------------------------------------------------------------ */
/* Add-to-box flight animation                                         */
/* ------------------------------------------------------------------ */

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Arcs a copy of the product art from the card into the bag button.
 * Purely decorative — state has already been committed by the time this runs.
 */
export function flyToBag(sourceEl, target, emoji) {
  if (!sourceEl || !target || prefersReducedMotion()) {
    bumpTarget(target);
    return;
  }

  const from = sourceEl.getBoundingClientRect();
  const to = target.getBoundingClientRect();

  const puck = document.createElement("div");
  puck.className = "flying-treat";
  puck.textContent = emoji;
  puck.setAttribute("aria-hidden", "true");
  puck.style.left = `${from.left + from.width / 2}px`;
  puck.style.top = `${from.top + from.height / 2}px`;
  document.body.appendChild(puck);

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  // Lift the midpoint so the treat arcs up and over rather than sliding.
  const lift = Math.min(-120, dy * 0.6 - 90);

  const flight = puck.animate(
    [
      { transform: "translate(-50%, -50%) scale(1) rotate(0deg)", opacity: 1, offset: 0 },
      {
        transform: `translate(calc(-50% + ${dx * 0.45}px), calc(-50% + ${lift}px)) scale(1.25) rotate(-18deg)`,
        opacity: 1,
        offset: 0.55
      },
      {
        transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.35) rotate(12deg)`,
        opacity: 0.2,
        offset: 1
      }
    ],
    { duration: 720, easing: "cubic-bezier(.45,.05,.35,1)" }
  );

  flight.onfinish = () => {
    puck.remove();
    bumpTarget(target);
  };
}

function bumpTarget(target) {
  if (!target || prefersReducedMotion()) return;
  target.animate(
    [
      { transform: "scale(1)" },
      { transform: "scale(1.16)" },
      { transform: "scale(1)" }
    ],
    { duration: 380, easing: "cubic-bezier(.34,1.56,.64,1)" }
  );
}

export { BOX_CAPACITY };
