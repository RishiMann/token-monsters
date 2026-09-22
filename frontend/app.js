const products = [
  { name: "Berry Cloud", description: "Strawberry · Vanilla · Soft cream", price: "$5.50", emoji: "🍓", tags: ["shareable", "new"] },
  { name: "Lemon Meringue", description: "Lemon curd · Toasted meringue", price: "$5.25", emoji: "🍋", tags: ["vegan", "new"] },
  { name: "Brown Butter Chip", description: "Sea salt · Dark chocolate", price: "$4.75", emoji: "🍪", tags: ["all"] },
  { name: "Pistachio Morning", description: "Pistachio · Apricot · Flaky pastry", price: "$6.00", emoji: "🥐", tags: ["shareable"] }
];
const productGrid = document.querySelector("#product-grid");
const toast = document.querySelector("#toast");
let cartCount = 0;
function renderProducts(filter = "all") {
  const visibleProducts = products.filter((product) => filter === "all" || product.tags.includes(filter));
  productGrid.innerHTML = visibleProducts.map((product) => `
    <article class="product-card">
      <div class="product-art"><span class="product-tag">${product.tags.includes("new") ? "NEW THIS WEEK" : "BAKED TODAY"}</span><span aria-hidden="true">${product.emoji}</span></div>
      <div class="product-info"><h3>${product.name}</h3><p>${product.description}</p><div class="product-foot"><span class="product-price">${product.price}</span><button class="add-button" aria-label="Add ${product.name} to bag" data-add="${product.name}">+</button></div></div>
    </article>`).join("");
  productGrid.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => {
    cartCount += 1;
    document.querySelector(".bag-count").textContent = cartCount;
    showToast(`${button.dataset.add} added to your bag`);
  }));
}
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("show"), 2400);
}
renderProducts();
document.querySelector('[data-action="filter"]').addEventListener("click", () => {
  const filterBar = document.querySelector("#filter-bar");
  filterBar.hidden = !filterBar.hidden;
});
document.querySelectorAll(".filter-chip").forEach((chip) => chip.addEventListener("click", () => {
  document.querySelector(".filter-chip.active").classList.remove("active");
  chip.classList.add("active");
  renderProducts(chip.dataset.filter);
}));
document.querySelectorAll(".choice").forEach((choice) => choice.addEventListener("click", () => {
  document.querySelectorAll(".choice").forEach((item) => item.classList.remove("selected"));
  choice.classList.add("selected");
  const occasion = choice.dataset.occasion;
  const recommendations = { "Just because": ["Berry Cloud", "Brown Butter Chip"], "Dinner party": ["Pistachio Morning", "Lemon Meringue"], Birthday: ["Berry Cloud", "Pistachio Morning"], "Thank you": ["Lemon Meringue", "Brown Butter Chip"] };
  document.querySelector("#concierge-result").hidden = false;
  document.querySelector("#concierge-result").innerHTML = `<div class="result-title">For your ${occasion.toLowerCase()}...</div><p class="result-copy">A little something bright, a little something buttery. We think this pairing will make the moment feel extra thoughtful.</p><div class="result-pills">${recommendations[occasion].map((item) => `<span class="result-pill">${item}</span>`).join("")}</div>`;
}));
document.querySelector('[data-action="cart"]').addEventListener("click", () => {
  showToast(cartCount ? `Your bag has ${cartCount} treat${cartCount === 1 ? "" : "s"}` : "Your bag is waiting for something sweet");
});
document.querySelector('[data-action="search"]').addEventListener("click", () => {
  showToast("Search is coming soon — try the Dessert Concierge ✦");
});
