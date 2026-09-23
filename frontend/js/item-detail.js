/**
 * The product detail dialog: picture, nutrition panel and that item's reviews.
 *
 * Opened from any menu card. Clicking the star rating opens the same dialog
 * scrolled to the reviews, which is what people expect a rating to do.
 */

import { fullMenu, eventMenus } from "./data.js";

const seasonalItems = eventMenus.flatMap((menu) =>
  (menu.items || []).map((item) => ({ ...item, seasonName: menu.name })));

const catalog = [...fullMenu, ...seasonalItems];

export const findItem = (id) => catalog.find((item) => item.id === id);

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const money = (value) => `$${Number(value).toFixed(2)}`;

const stars = (rating) => {
  const rounded = Math.round(rating);
  return `${"★".repeat(rounded)}${"☆".repeat(Math.max(0, 5 - rounded))}`;
};

const longDate = (iso) => {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00`)
    .toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

function nutritionPanel(item) {
  const nutrition = item.nutrition;
  if (!nutrition) return "";
  return `
    <div class="nutrition-panel">
      <h4>Nutrition</h4>
      <p class="nutrition-serving">Per serving · ${nutrition.servingGrams}g</p>
      <p class="nutrition-calories"><strong>${nutrition.calories}</strong><span>calories</span></p>
      <table class="nutrition-table">
        <thead><tr><th>Nutrient</th><th>Amount</th><th>% DV</th></tr></thead>
        <tbody>
          ${nutrition.perServing.map((row) => `
            <tr>
              <td>${esc(row.label)}</td>
              <td class="num">${esc(row.value)}</td>
              <td class="num">${row.dv == null ? "—" : `${row.dv}%`}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="nutrition-note">
        % Daily Value is based on a 2,000 calorie diet. Every tray is finished on a
        shared line, so traces of other allergens are possible.
      </p>
    </div>`;
}

function allergenRow(item) {
  const allergens = item.allergens || [];
  const dietary = item.dietary || [];
  if (!allergens.length && !dietary.length) return "";
  return `
    <div class="item-tags">
      ${dietary.map((tag) => `<span class="tag tag-good">${esc(tag)}</span>`).join("")}
      ${allergens.map((tag) => `<span class="tag tag-warn">Contains ${esc(tag)}</span>`).join("")}
    </div>`;
}

function reviewsPanel(item) {
  const reviews = item.reviews || [];
  if (!reviews.length) {
    return `<div class="reviews-panel" id="item-reviews"><h4>Reviews</h4>
      <p class="empty">No reviews for this one yet.</p></div>`;
  }
  const average = reviews.reduce((sum, review) => sum + review.stars, 0) / reviews.length;
  const spread = [5, 4, 3, 2, 1].map((star) => ({
    star,
    count: reviews.filter((review) => review.stars === star).length
  }));

  return `
    <div class="reviews-panel" id="item-reviews">
      <h4>Reviews</h4>
      <div class="reviews-summary">
        <div class="reviews-score">
          <strong>${average.toFixed(1)}</strong>
          <span class="reviews-stars">${stars(average)}</span>
          <small>${reviews.length} review${reviews.length === 1 ? "" : "s"}</small>
        </div>
        <div class="reviews-spread">
          ${spread.map((row) => `
            <div class="spread-row">
              <span>${row.star}★</span>
              <div class="spread-bar"><i style="width:${(row.count / reviews.length) * 100}%"></i></div>
              <span class="spread-count">${row.count}</span>
            </div>`).join("")}
        </div>
      </div>
      <ul class="review-list">
        ${reviews.map((review) => `
          <li class="review">
            <div class="review-head">
              <span class="review-avatar">${esc(review.initials)}</span>
              <div>
                <strong>${esc(review.name)}</strong>
                <small>${esc(review.verified)} · ${esc(longDate(review.date))}</small>
              </div>
              <span class="review-stars">${stars(review.stars)}</span>
            </div>
            <p>${esc(review.body)}</p>
          </li>`).join("")}
      </ul>
    </div>`;
}

let dialog = null;
let body = null;

export function initItemDetail({ onAdd } = {}) {
  dialog = document.querySelector("[data-item-dialog]");
  body = document.querySelector("[data-item-dialog-body]");
  if (!dialog || !body) return;

  document.querySelector("[data-item-close]")?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();   // click the backdrop
  });

  document.addEventListener("click", (event) => {
    const add = event.target.closest("[data-detail-add]");
    if (add && onAdd) {
      onAdd(add.dataset.detailAdd);
      return;
    }
    const trigger = event.target.closest("[data-open-item]");
    if (!trigger) return;
    // A star rating opens straight to the reviews.
    const toReviews = trigger.matches("[data-open-reviews]");
    open(trigger.dataset.openItem, { reviews: toReviews });
  });
}

export function open(itemId, { reviews = false } = {}) {
  const item = findItem(itemId);
  if (!item || !dialog) return;

  const reviewCount = (item.reviews || []).length;
  body.innerHTML = `
    <article class="item-detail tint-${item.tint}">
      <img class="item-detail-photo" src="${esc(item.image)}" alt="${esc(item.name)}"
           width="400" height="300" />
      <div class="item-detail-main">
        <p class="item-detail-eyebrow">
          ${item.seasonName ? esc(item.seasonName) : esc(item.badge || "On the menu")}
        </p>
        <h3 id="item-dialog-title">${esc(item.name)}</h3>
        <button class="item-detail-rating" type="button" data-scroll-reviews
                aria-label="Read the ${reviewCount} reviews for ${esc(item.name)}">
          <span class="stars">${stars(item.rating)}</span>
          <span>${item.rating} · ${reviewCount} review${reviewCount === 1 ? "" : "s"}</span>
        </button>
        <p class="item-detail-blurb">${esc(item.blurb)}</p>
        ${allergenRow(item)}
        <div class="item-detail-foot">
          <span class="item-detail-price">${money(item.price)}</span>
          <button class="button" type="button" data-detail-add="${esc(item.id)}">Add to box</button>
        </div>
      </div>
    </article>
    <div class="item-detail-panels">
      ${nutritionPanel(item)}
      ${reviewsPanel(item)}
    </div>`;

  body.querySelector("[data-scroll-reviews]")?.addEventListener("click", () => {
    body.querySelector("#item-reviews")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  if (!dialog.open) dialog.showModal();
  if (reviews) {
    requestAnimationFrame(() =>
      body.querySelector("#item-reviews")?.scrollIntoView({ block: "start" }));
  } else {
    body.scrollTop = 0;
  }
}
