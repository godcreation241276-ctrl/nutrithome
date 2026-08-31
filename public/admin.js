
const $ = (id) => document.getElementById(id);
const API = '';
let adminKey = localStorage.getItem('nh_admin_key') || '';
let orders = [];
let menu = [];
let lastSeenOrderId = Number(localStorage.getItem('nh_last_order_id') || 0);
let refreshTimer = null;
let audioCtx = null;
let ringTimer = null;
let ringStopTimer = null;

function headers(json=true){ const h={'x-admin-key':adminKey}; if(json) h['Content-Type']='application/json'; return h; }
function money(n){ return `₹${Number(n||0).toLocaleString('en-IN')}`; }
function esc(s){ return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function toast(msg){ $('toast').textContent=msg; $('toast').classList.remove('hidden'); setTimeout(()=>$('toast').classList.add('hidden'),2600); }

async function api(path, opts={}){
  const res = await fetch(API+path,{...opts,headers:{...headers(!(opts.body instanceof FormData)),...(opts.headers||{})}});
  const txt=await res.text(); let data={}; try{data=txt?JSON.parse(txt):{}}catch{data={error:txt||`HTTP ${res.status}`}}
  if(res.status===401){ logout(); throw new Error('Admin key is invalid'); }
  if(!res.ok) throw new Error(data.error||data.message||`Request failed (${res.status})`);
  return data;
}

async function login(){
  adminKey=$('adminKeyInput').value.trim();
  $('loginError').textContent='';
  if(!adminKey){$('loginError').textContent='Enter ADMIN_KEY';return;}
  try{
    await api('/admin/summary');
    localStorage.setItem('nh_admin_key',adminKey);
    showDashboard();
  }catch(e){$('loginError').textContent=e.message;}
}
function logout(){ localStorage.removeItem('nh_admin_key'); adminKey=''; clearInterval(refreshTimer); $('dashboardView').classList.add('hidden'); $('loginView').classList.remove('hidden'); }
async function showDashboard(){
  $('loginView').classList.add('hidden'); $('dashboardView').classList.remove('hidden');
  await refreshAll(true);
  clearInterval(refreshTimer); refreshTimer=setInterval(()=>refreshAll(false),8000);
}
async function refreshAll(initial=false){
  try{
    const [s,o]=await Promise.all([api('/admin/summary'),api('/admin/orders')]);
    $('connectionLabel').textContent='Online';
    $('mOrders').textContent=s.totalOrders??0; $('mRevenue').textContent=money(s.totalRevenue);
    $('mPending').textContent=s.pending??0; $('mAccepted').textContent=s.accepted??0; $('mPreparing').textContent=s.preparing??0; $('mReady').textContent=s.ready??0;
    orders=Array.isArray(o)?o:[];
    detectNewOrders(initial);
    renderOrders();
  }catch(e){ $('connectionLabel').textContent='Connection issue'; console.error(e); }
}
function detectNewOrders(initial){
  const maxId=Math.max(0,...orders.map(o=>Number(o.id)||0));
  if(!initial && maxId>lastSeenOrderId){
    const fresh=orders.filter(o=>Number(o.id)>lastSeenOrderId && o.status==='NEW');
    if(fresh.length){ ring(); browserNotify(fresh[0]); toast(`${fresh.length} new order${fresh.length>1?'s':''} received`); }
  }
  if(maxId>lastSeenOrderId){ lastSeenOrderId=maxId; localStorage.setItem('nh_last_order_id',String(maxId)); }
}
function getAudioContext(){
  if(!audioCtx){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(AC) audioCtx = new AC();
  }
  return audioCtx;
}
async function unlockAudio(){
  try{
    const c = getAudioContext();
    if(c && c.state === 'suspended') await c.resume();
    if(c){
      const o=c.createOscillator(), g=c.createGain();
      g.gain.value=.00001; o.connect(g).connect(c.destination);
      o.start(); o.stop(c.currentTime+.03);
    }
    return true;
  }catch(e){ console.warn('Audio unlock failed',e); return false; }
}
function stopRing(){
  if(ringTimer){ clearInterval(ringTimer); ringTimer=null; }
  if(ringStopTimer){ clearTimeout(ringStopTimer); ringStopTimer=null; }
}
function ringBurst(){
  try{
    const c=getAudioContext(); if(!c) return;
    if(c.state==='suspended') c.resume();
    const now=c.currentTime;
    [0,.18,.36,.54].forEach((t,idx)=>{
      const o=c.createOscillator(), g=c.createGain();
      o.type=idx%2===0?'square':'sine';
      o.frequency.setValueAtTime(idx%2===0?930:760,now+t);
      g.gain.setValueAtTime(.0001,now+t);
      g.gain.exponentialRampToValueAtTime(.42,now+t+.015);
      g.gain.exponentialRampToValueAtTime(.0001,now+t+.15);
      o.connect(g).connect(c.destination);
      o.start(now+t); o.stop(now+t+.17);
    });
  }catch(e){ console.warn('Ring failed',e); }
}
function ring(){
  stopRing();
  ringBurst();
  ringTimer=setInterval(ringBurst,1400);
  ringStopTimer=setTimeout(stopRing,12000);
}
function browserNotify(o){
  if('Notification' in window && Notification.permission==='granted') new Notification('New Nutri Home Order',{body:`Order #${o.id} • ${money(o.total)}`});
}
async function enableAlerts(){
  await unlockAudio();
  let notificationOk=false;
  if('Notification' in window){
    try{
      const p=Notification.permission==='granted'?'granted':await Notification.requestPermission();
      notificationOk=(p==='granted');
    }catch(e){ console.warn(e); }
  }
  ringBurst();
  toast(notificationOk?'Alerts enabled — test sound played':'Sound enabled. Browser notification permission is not granted.');
}
function testAlert(){
  unlockAudio().then(()=>{
    ring();
    browserNotify({id:'TEST',total:11});
    toast('Test alert sent — ring should play for 12 seconds');
  });
}
function parseItems(v){try{return Array.isArray(v)?v:JSON.parse(v||'[]')}catch{return[]}}
function mapsUrl(o){ if(o.latitude!=null&&o.longitude!=null)return `https://www.google.com/maps?q=${encodeURIComponent(o.latitude+','+o.longitude)}`; return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.customer_address||'')}`; }

function renderOrders(){
  const filter=$('statusFilter').value; const list=orders.filter(o=>filter==='ALL'||o.status===filter);
  $('ordersList').innerHTML=list.length?list.map(o=>{
    const items=parseItems(o.items);
    return `<article class="order-card ${o.status==='NEW'?'new-order':''}">
      <div class="order-top"><div><div class="order-id">Order #${o.id}</div><div class="muted small">${esc(o.created_at||'')}</div></div><span class="badge ${esc(o.status)}">${esc(o.status)}</span></div>
      <div class="customer"><strong>${esc(o.customer_name)}</strong><div>${esc(o.customer_phone)}</div><div>${esc(o.customer_address)}</div><a class="link" target="_blank" rel="noopener" href="${mapsUrl(o)}">Open location in Maps ↗</a></div>
      <div class="items">${items.map(i=>`<div class="item-line"><div>${esc(i.name)} × ${Number(i.qty||1)} ${i.variant?`<div class="variant">${esc(i.variant)}</div>`:''}</div><strong>${money(i.line_total ?? (Number(i.price||0)*Number(i.qty||1)))}</strong></div>`).join('')}</div>
      <div class="order-foot"><span>Total</span><span class="total">${money(o.total)}</span></div>
      ${o.delivery_booking_id?`<div class="delivery">Rider: ${esc(o.delivery_status||'BOOKED')} ${o.delivery_tracking_url?`• <a class="link" href="${esc(o.delivery_tracking_url)}" target="_blank">Track</a>`:''}</div>`:''}
      <div class="actions">
        ${o.status==='NEW'?`<button class="btn primary" onclick="setStatus(${o.id},'ACCEPTED')">Accept</button>`:''}
        ${['NEW','ACCEPTED'].includes(o.status)?`<button class="btn ghost" onclick="setStatus(${o.id},'PREPARING')">Preparing</button>`:''}
        ${['ACCEPTED','PREPARING'].includes(o.status)?`<button class="btn ghost" onclick="setStatus(${o.id},'READY')">Ready</button>`:''}
        ${o.status==='READY'?`<button class="btn primary" onclick="bookRider(${o.id})">Book rider</button>`:''}
        ${o.status==='OUT_FOR_DELIVERY'?`<button class="btn primary" onclick="setStatus(${o.id},'DELIVERED')">Delivered</button>`:''}
        ${!['DELIVERED','CANCELLED'].includes(o.status)?`<button class="btn danger-soft" onclick="setStatus(${o.id},'CANCELLED')">Cancel</button>`:''}
      </div>
    </article>`;
  }).join(''):'<div class="metric">No orders found.</div>';
}
async function setStatus(id,status){ try{await api('/admin/order-status',{method:'POST',body:JSON.stringify({orderId:id,status})});toast(`Order #${id}: ${status}`);await refreshAll(false);}catch(e){alert(e.message)} }
async function bookRider(id){ try{const r=await api('/admin/book-rider',{method:'POST',body:JSON.stringify({orderId:id})});toast(r.delivery?.alreadyBooked?'Rider already booked':'Rider booking sent');await refreshAll(false);}catch(e){alert(e.message)} }

async function loadMenu(){
  try{menu=await api('/admin/menu');renderMenu();}catch(e){alert(e.message)}
}
function renderMenu(){
  const q=$('menuSearch').value.toLowerCase().trim();
  const list=menu.filter(i=>`${i.name} ${i.category}`.toLowerCase().includes(q));
  $('menuList').innerHTML=list.map(i=>`<article class="menu-card" onclick="editItem(${i.id})">
    ${i.image?`<img src="${esc(i.image)}" onerror="this.style.visibility='hidden'">`:`<div style="height:150px;display:grid;place-items:center;background:#eaf1ec;font-weight:900;font-size:42px;color:#1f6f3d">NH</div>`}
    <div class="menu-body"><div class="menu-title">${esc(i.name)}</div><div class="menu-meta">${esc(i.category||'')} • ${i.active==='no'?'Inactive':'Active'} • ${(i.variants||[]).length} variants</div><div class="menu-price">${money(i.price)}</div></div>
  </article>`).join('');
}
function addVariantRow(v={}){
  const row=document.createElement('div');row.className='variant-row';row.dataset.id=v.id||'';
  row.innerHTML=`<input class="v-label" placeholder="e.g. 300 ml / Half" value="${esc(v.label||'')}"><input class="v-price" type="number" min="1" placeholder="Price" value="${v.price||''}"><button type="button" class="remove-variant">×</button>`;
  row.querySelector('.remove-variant').onclick=()=>row.remove();$('variantsBox').appendChild(row);
}
function resetMenuForm(){
  $('itemId').value='';$('itemName').value='';$('itemCategory').value='';$('itemPrice').value='';$('itemActive').value='yes';$('itemImage').value='';$('itemPreview').removeAttribute('src');$('variantsBox').innerHTML='';$('deleteItemBtn').classList.add('hidden');$('menuError').textContent='';
}
function newItem(){resetMenuForm();$('menuDialogTitle').textContent='Add menu item';$('menuDialog').showModal();}
function editItem(id){
  const i=menu.find(x=>Number(x.id)===Number(id));if(!i)return;resetMenuForm();$('menuDialogTitle').textContent=`Edit: ${i.name}`;$('itemId').value=i.id;$('itemName').value=i.name||'';$('itemCategory').value=i.category||'';$('itemPrice').value=i.price||0;$('itemActive').value=i.active==='no'?'no':'yes';$('itemImage').value=i.image||'';if(i.image)$('itemPreview').src=i.image;(i.variants||[]).forEach(addVariantRow);$('deleteItemBtn').classList.remove('hidden');$('menuDialog').showModal();
}
async function uploadImage(){
  const f=$('imageFile').files[0];if(!f){toast('Choose or take a photo first');return;}
  const fd=new FormData();fd.append('image',f);
  try{
    const res=await fetch('/admin/menu-image',{method:'POST',headers:{'x-admin-key':adminKey},body:fd});const j=await res.json();
    if(!res.ok)throw new Error(j.error||'Upload failed');$('itemImage').value=j.url;$('itemPreview').src=j.url;toast('Photo uploaded');
  }catch(e){alert(e.message)}
}
async function removeImage(){
  const url=$('itemImage').value;if(!url){$('itemPreview').removeAttribute('src');return;}
  if(!confirm('Remove this photo?'))return;
  try{await api('/admin/menu-image',{method:'DELETE',body:JSON.stringify({url})});$('itemImage').value='';$('itemPreview').removeAttribute('src');toast('Photo removed');}catch(e){alert(e.message)}
}
async function saveItem(ev){
  ev.preventDefault();
  const variants=[...document.querySelectorAll('.variant-row')].map((r,idx)=>({id:r.dataset.id||`web_${Date.now()}_${idx}`,label:r.querySelector('.v-label').value.trim(),price:Number(r.querySelector('.v-price').value||0)})).filter(v=>v.label&&v.price>0);
  const payload={name:$('itemName').value.trim(),category:$('itemCategory').value.trim(),price:Number($('itemPrice').value||0),active:$('itemActive').value,image:$('itemImage').value,variants};
  if(!payload.name){$('menuError').textContent='Item name is required';return;}
  const id=$('itemId').value;
  try{await api(id?`/admin/menu/${id}`:'/admin/menu',{method:id?'PUT':'POST',body:JSON.stringify(payload)});$('menuDialog').close();toast('Menu saved');await loadMenu();}catch(e){$('menuError').textContent=e.message}
}
async function deleteItem(){
  const id=$('itemId').value;if(!id||!confirm('Delete this menu item permanently?'))return;
  try{await api(`/admin/menu/${id}`,{method:'DELETE'});$('menuDialog').close();toast('Item deleted');await loadMenu();}catch(e){alert(e.message)}
}
function switchTab(name){
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
  $('ordersTab').classList.toggle('hidden',name!=='orders');$('menuTab').classList.toggle('hidden',name!=='menu');
  if(name==='menu')loadMenu();
}

$('loginBtn').onclick=login;$('adminKeyInput').addEventListener('keydown',e=>{if(e.key==='Enter')login()});
$('logoutBtn').onclick=logout;$('refreshBtn').onclick=()=>refreshAll(false);$('notifyBtn').onclick=enableAlerts;$('testAlertBtn').onclick=testAlert;$('statusFilter').onchange=renderOrders;
document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
$('newItemBtn').onclick=newItem;$('menuSearch').oninput=renderMenu;$('addVariantBtn').onclick=()=>addVariantRow();$('uploadImageBtn').onclick=uploadImage;$('removeImageBtn').onclick=removeImage;$('menuForm').onsubmit=saveItem;$('deleteItemBtn').onclick=deleteItem;

if(adminKey){ $('adminKeyInput').value=adminKey; showDashboard(); }

window.addEventListener('click', (e)=>{ if(e.target.closest('.order-card .btn')) stopRing(); });
