let menuData = [];
let cart = {};

// Fetch menu
fetch('/menu')
  .then(res => res.json())
  .then(data => {
    menuData = data;
    renderCategories();
    renderMenu('All');
  });

/* -----------------------------
   RENDER CATEGORY TABS
----------------------------- */
function renderCategories() {
  const categories = ['All', ...new Set(menuData.map(i => i.category))];
  const container = document.getElementById('categories');
  container.innerHTML = '';

  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.innerText = cat;
    btn.onclick = () => {
      document.querySelectorAll('.categories button')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderMenu(cat);
    };
    container.appendChild(btn);
  });

  if (container.firstChild) container.firstChild.classList.add('active');
}

/* -----------------------------
   RENDER MENU
----------------------------- */
function renderMenu(category) {
  const menuDiv = document.getElementById('menu');
  menuDiv.innerHTML = '';

  const filtered = category === 'All'
    ? menuData
    : menuData.filter(i => i.category === category);

  filtered.forEach(item => {
    const safeName = item.name.replace(/'/g, "\\'");
    const card = document.createElement('div');
    card.className = 'card';

    card.innerHTML = `
      <img src="${item.image && item.image !== 'null'
        ? item.image
        : 'https://nutrihomefoods.com/images/menu/placeholder.jpg'}">

      <div class="card-details">
        <h3>${item.name}</h3>
        <p>₹${item.price}</p>
      </div>

      <div class="qty-box" id="qty-${item.id}">
        <button onclick="decrease(${item.id})">−</button>
        <span>0</span>
        <button onclick="addToCart(${item.id}, '${safeName}', ${item.price})">+</button>
      </div>
    `;

    menuDiv.appendChild(card);
    updateQtyUI(item.id);
  });
}

/* -----------------------------
   CART LOGIC
----------------------------- */
function addToCart(id, name, price) {
  if (!cart[id]) cart[id] = { name, price, qty: 1 };
  else cart[id].qty++;

  updateCart();
  updateQtyUI(id);
}

function decrease(id) {
  if (!cart[id]) return;

  cart[id].qty--;
  if (cart[id].qty <= 0) delete cart[id];

  updateCart();
  updateQtyUI(id);
}

function updateQtyUI(id) {
  const box = document.getElementById(`qty-${id}`);
  if (!box) return;
  box.querySelector('span').innerText = cart[id]?.qty || 0;
}

function updateCart() {
  const cartBar = document.getElementById('cartBar');
  const cartInfo = document.getElementById('cartInfo');

  let total = 0, items = 0;
  for (let k in cart) {
    total += cart[k].price * cart[k].qty;
    items += cart[k].qty;
  }

  if (items > 0) {
    cartBar.classList.remove('hidden');
    cartInfo.innerText = `${items} items | ₹${total}`;
  } else {
    cartBar.classList.add('hidden');
  }
}

/* -----------------------------
   CHECKOUT FLOW
----------------------------- */
function checkout() {
  document.getElementById('customerForm').classList.remove('hidden');
}
function closeForm() {
  document.getElementById('customerForm').classList.add('hidden');
}

function confirmOrder() {
  const name = custName.value.trim();
  const phone = custPhone.value.trim();
  const address = custAddress.value.trim();

  if (!name || !phone || !address) {
    alert("Please fill all details");
    return;
  }

  let itemsArray = [];
  let total = 0;

  for (let k in cart) {
    itemsArray.push(cart[k]);
    total += cart[k].price * cart[k].qty;
  }

  // 🔹 Build WhatsApp message FIRST
  let msg = `Name: ${name}\nPhone: ${phone}\nAddress: ${address}\n\nItems:\n`;
  itemsArray.forEach(i => {
    msg += `${i.name} x${i.qty} - ₹${i.price * i.qty}\n`;
  });
  msg += `\nTotal: ₹${total}`;

  const whatsappURL =
    `https://wa.me/918287691419?text=${encodeURIComponent(msg)}`;

  // 🔥 OPEN WHATSAPP IMMEDIATELY (user-triggered)
  window.open(whatsappURL, '_blank');

  // 🔹 Save order in background (does not block popup)
  fetch('/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: name,
      customer_phone: phone,
      customer_address: address,
      items: itemsArray,
      total
    })
  });

  cart = {};
  updateCart();
  document.getElementById('customerForm').classList.add('hidden');
  renderMenu('All');
}