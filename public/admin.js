const container = document.getElementById('ordersContainer');

/* =========================
   DASHBOARD SUMMARY
========================= */
function loadSummary() {
  fetch('/admin/summary')
    .then(res => res.json())
    .then(data => {
      document.getElementById('sumOrders').innerText = data.totalOrders;
      document.getElementById('sumRevenue').innerText = data.totalRevenue;
      document.getElementById('sumPending').innerText = data.pending;
      document.getElementById('sumAccepted').innerText = data.accepted;
    });
}

/* =========================
   STATUS COLOR HELPER
========================= */
function getStatusColor(status) {
  switch (status) {
    case 'NEW': return '#ff9800';
    case 'ACCEPTED': return '#2196f3';
    case 'PREPARING': return '#9c27b0';
    case 'READY': return '#00bcd4';
    case 'ON_THE_WAY': return '#3f51b5';
    case 'DELIVERED': return '#4caf50';
    default: return '#999';
  }
}

/* =========================
   NEXT BUTTON HELPER
========================= */
function getNextButton(order) {

  const safeName = order.customer_name.replace(/'/g, "\\'");
  const safePhone = order.customer_phone.replace(/'/g, "\\'");

  if (order.status === 'NEW')
    return `<button onclick="changeStatus(${order.id}, 'ACCEPTED', '${safeName}', '${safePhone}')">Accept</button>`;

  if (order.status === 'ACCEPTED')
    return `<button onclick="changeStatus(${order.id}, 'PREPARING', '${safeName}', '${safePhone}')">Start Preparing</button>`;

  if (order.status === 'PREPARING')
    return `<button onclick="changeStatus(${order.id}, 'READY', '${safeName}', '${safePhone}')">Mark Ready</button>`;

  if (order.status === 'READY')
    return `<button onclick="changeStatus(${order.id}, 'ON_THE_WAY', '${safeName}', '${safePhone}')">Out for Delivery</button>`;

  if (order.status === 'ON_THE_WAY')
    return `<button onclick="changeStatus(${order.id}, 'DELIVERED', '${safeName}', '${safePhone}')">Delivered</button>`;

  return '';
}

/* =========================
   LOAD ORDERS
========================= */
function loadOrders() {
  fetch('/admin/orders')
    .then(res => res.json())
    .then(data => {

      container.innerHTML = '';

      if (!data || data.length === 0) {
        container.innerHTML = '<p style="color:#aaa;padding:15px">No orders yet.</p>';
        return;
      }

      data.forEach(order => {

        const card = document.createElement('div');
        card.className = 'order-card';

        const items = JSON.parse(order.items || '[]');
        let itemsHTML = '';

        items.forEach(i => {
          itemsHTML += `<div>${i.name} x${i.qty} — ₹${i.price * i.qty}</div>`;
        });

        const date = new Date(order.created_at).toLocaleString('en-IN');
        const statusColor = getStatusColor(order.status);

        card.innerHTML = `
          <div class="order-id">Order #${order.id}</div>
          <div class="order-date">${date}</div>

          <div class="order-status" style="color:${statusColor}">
            Status: <b>${order.status.replaceAll('_',' ')}</b>
          </div>

          <div><b>Name:</b> ${order.customer_name}</div>
          <div><b>Phone:</b> ${order.customer_phone}</div>
          <div><b>Address:</b> ${order.customer_address}</div>

          <div class="order-items">${itemsHTML}</div>
          <div class="order-total">Total: ₹${order.total}</div>

          <div class="order-actions">
            ${getNextButton(order)}
          </div>
        `;

        container.appendChild(card);
      });
    });
}

/* =========================
   STATUS CHANGE + WHATSAPP
========================= */
function changeStatus(orderId, newStatus, name, phone) {

  fetch('/admin/order-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId, status: newStatus })
  })
  .then(() => {

    sendWhatsAppNotification(orderId, newStatus, name, phone);

    loadSummary();
    loadOrders();
  });
}

/* =========================
   WHATSAPP MESSAGE BUILDER
========================= */
function sendWhatsAppNotification(orderId, status, name, phone) {

  phone = phone.replace(/\D/g, '');

  if (phone.startsWith('0')) phone = phone.substring(1);
  if (!phone.startsWith('91')) phone = '91' + phone;

  let message = '';

  switch (status) {

    case 'ACCEPTED':
      message =
        `Hi ${name},\n\n` +
        `Your order #${orderId} has been ACCEPTED 🍱\n` +
        `We are preparing it now.\n\nThank you 🙏`;
      break;

    case 'PREPARING':
      message =
        `Hi ${name},\n\n` +
        `Your order #${orderId} is being PREPARED 👨‍🍳\n` +
        `Almost ready!\n\nThank you 🙏`;
      break;

    case 'READY':
      message =
        `Hi ${name},\n\n` +
        `Your order #${orderId} is READY 🎉\n` +
        `Dispatching shortly.\n\nThank you 🙏`;
      break;

    case 'ON_THE_WAY':
      message =
        `Hi ${name},\n\n` +
        `Your order #${orderId} is ON THE WAY 🚚\n` +
        `Please be available to receive it.\n\nThank you 🙏`;
      break;

    case 'DELIVERED':
      message =
        `Hi ${name},\n\n` +
        `Your order #${orderId} has been DELIVERED ✅\n` +
        `We hope you enjoyed your meal!\n\nThank you 🙏`;
      break;
  }

  if (message) {
    const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    window.open(waUrl, '_blank');
  }
}

/* =========================
   INIT + AUTO REFRESH
========================= */
loadSummary();
loadOrders();

setInterval(() => {
  loadSummary();
  loadOrders();
}, 5000);