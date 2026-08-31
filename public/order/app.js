const API_BASE = location.origin;
const FALLBACK = '/order/icons/icon-512.png';
const state = { menu: [], category: 'All', search: '', cart: new Map(), selectedItem: null, coords: null };
const $ = (id) => document.getElementById(id);
const money = (n) => `₹${Math.round(Number(n)||0)}`;
const imageUrl = (value) => { if(!value) return FALLBACK; const v=String(value).trim(); if(/^https?:\/\//i.test(v)) return v; return `${API_BASE}${v.startsWith('/')?'':'/'}${v}`; };
const esc = (s='') => String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
function keyFor(item, variant){return `${item.id}::${variant?.id || variant?.label || 'base'}`}
function lines(){return [...state.cart.values()].filter(x=>x.qty>0)}
function cartQty(){return lines().reduce((s,x)=>s+x.qty,0)}
function cartTotal(){return lines().reduce((s,x)=>s+x.qty*Number(x.price),0)}
function qtyForItem(id){return lines().filter(x=>x.item.id===id).reduce((s,x)=>s+x.qty,0)}
function showToast(msg){const t=$('toast');t.textContent=msg;t.classList.remove('hidden');clearTimeout(showToast.t);showToast.t=setTimeout(()=>t.classList.add('hidden'),2600)}
function openSheet(id){$('sheetBackdrop').classList.remove('hidden');$(id).classList.remove('hidden');document.body.style.overflow='hidden'}
function closeSheets(){['variantSheet','cartSheet','checkoutSheet','successSheet'].forEach(id=>$(id).classList.add('hidden'));$('sheetBackdrop').classList.add('hidden');document.body.style.overflow=''}
async function loadMenu(){const box=$('menuState');box.classList.remove('hidden');box.textContent='Loading menu…';try{const r=await fetch(`${API_BASE}/menu`,{headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`Menu request failed (${r.status})`);const data=await r.json();state.menu=Array.isArray(data)?data:[];renderCategories();renderMenu();box.classList.add('hidden')}catch(e){box.textContent='Menu could not be loaded. Tap to retry.';box.onclick=loadMenu}}
function renderCategories(){const cats=['All',...new Set(state.menu.map(x=>x.category).filter(Boolean))];$('categories').innerHTML=cats.map(c=>`<button class="chip ${state.category===c?'active':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
function renderMenu(){const q=state.search.trim().toLowerCase();const items=state.menu.filter(i=>(state.category==='All'||i.category===state.category)&&(!q||String(i.name||'').toLowerCase().includes(q)));$('menuGrid').innerHTML=items.map(item=>{const variants=Array.isArray(item.variants)?item.variants:[];const shownPrice=variants.length?Math.min(...variants.map(v=>Number(v.price)||Infinity)):Number(item.price||0);const qty=qtyForItem(item.id);return `<article class="menu-card"><img class="food-image" src="${esc(imageUrl(item.image))}" alt="${esc(item.name)}" loading="lazy" onerror="this.onerror=null;this.src='${FALLBACK}'"><div class="food-body"><div class="food-cat">${esc(item.category||'Menu')}</div><div class="food-name">${esc(item.name)}</div>${variants.length?`<div class="variant-note">${variants.length} size option${variants.length>1?'s':''}</div>`:''}<div class="food-bottom"><div class="price">${variants.length?'From ':''}${money(shownPrice)}</div>${qty?`<div class="qty-control"><button data-action="minus-item" data-id="${item.id}">−</button><span>${qty}</span><button data-action="add" data-id="${item.id}">+</button></div>`:`<button class="add-btn" data-action="add" data-id="${item.id}">ADD</button>`}</div></div></article>`}).join('');if(!items.length){$('menuGrid').innerHTML='<div class="state-card">No matching dishes found.</div>'}renderCartBar()}
function renderCartBar(){const q=cartQty(),total=cartTotal();$('cartQty').textContent=q;$('cartTotal').textContent=money(total);$('cartBar').classList.toggle('hidden',q===0)}
function addResolved(item,variant=null){const key=keyFor(item,variant),old=state.cart.get(key);state.cart.set(key,{item,variant,price:Number(variant?.price ?? item.price ?? 0),qty:(old?.qty||0)+1});renderMenu();renderCart()}
function addItem(item){const variants=Array.isArray(item.variants)?item.variants:[];if(variants.length){state.selectedItem=item;$('variantTitle').textContent=item.name;$('variantOptions').innerHTML=variants.map((v,i)=>`<button class="variant-option" data-variant="${i}"><div><strong>${esc(v.label)}</strong></div><span>${money(v.price)}</span></button>`).join('');openSheet('variantSheet')}else addResolved(item)}
function decrementKey(key){const line=state.cart.get(key);if(!line)return;line.qty-=1;if(line.qty<=0)state.cart.delete(key);else state.cart.set(key,line);renderMenu();renderCart()}
function decrementItem(id){const entry=[...state.cart.entries()].find(([,x])=>x.item.id===id&&x.qty>0);if(entry)decrementKey(entry[0])}
function renderCart(){const box=$('cartLines');const ls=lines();box.innerHTML=ls.length?ls.map(x=>{const key=keyFor(x.item,x.variant);return `<div class="cart-line"><div><div class="line-name">${esc(x.item.name)}</div>${x.variant?`<div class="line-variant">${esc(x.variant.label)}</div>`:''}</div><div class="line-right"><div class="line-price">${money(x.price*x.qty)}</div><div class="mini-qty"><button data-cart-minus="${esc(key)}">−</button><span>${x.qty}</span><button data-cart-plus="${esc(key)}">+</button></div></div></div>`}).join(''):'<div class="state-card">Your cart is empty.</div>';$('sheetTotal').textContent=money(cartTotal());$('checkoutTotal').textContent=money(cartTotal());$('checkoutBtn').disabled=!ls.length}
function validateCheckout(){const name=$('customerName').value.trim();const phone=$('customerPhone').value.replace(/\D/g,'').slice(-10);const address=$('customerAddress').value.trim();if(!name)return 'Please enter your name.';if(!/^[6-9]\d{9}$/.test(phone))return 'Please enter a valid 10-digit Indian mobile number.';if(!address)return 'Please enter your delivery address.';if(!lines().length)return 'Your cart is empty.';return ''}
async function reverseGeocode(lat,lng){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  try{
    const r=await fetch(`${API_BASE}/reverse-geocode?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}&t=${Date.now()}`,{
      headers:{Accept:'application/json'},
      cache:'no-store',
      signal:controller.signal
    });
    if(!r.ok)throw new Error(`Address lookup failed (${r.status})`);
    const d=await r.json();
    return String(d.address||'').trim();
  }finally{clearTimeout(timer)}
}
async function useLocation(){
  const btn=$('locationBtn'),status=$('locationStatus');
  if(!navigator.geolocation){showToast('Location is not supported on this browser.');return}
  btn.disabled=true;
  status.textContent='Getting accurate GPS location…';

  navigator.geolocation.getCurrentPosition(async pos=>{
    const lat=pos.coords.latitude,lng=pos.coords.longitude;
    state.coords={latitude:lat,longitude:lng};
    status.textContent=`GPS captured: ${lat.toFixed(5)}, ${lng.toFixed(5)} • Finding address…`;

    let address='';
    try{
      address=await reverseGeocode(lat,lng);
      if(!address){
        await new Promise(r=>setTimeout(r,700));
        address=await reverseGeocode(lat,lng);
      }
    }catch(e){
      console.warn('Reverse geocode failed:',e);
    }

    if(address){
      $('customerAddress').value=address;
      status.textContent=`Location found • GPS ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      showToast('Delivery address filled from current location.');
    }else{
      $('customerAddress').value='';
      status.textContent=`GPS captured: ${lat.toFixed(5)}, ${lng.toFixed(5)} • Address lookup failed`;
      showToast('GPS मिला है, लेकिन address नहीं मिला. कृपया delivery address manually enter करें.');
    }
    btn.disabled=false;
  },err=>{
    status.textContent='';
    btn.disabled=false;
    showToast(err.code===1?'Please allow location permission in your browser.':'Could not get current location.');
  },{enableHighAccuracy:true,timeout:20000,maximumAge:0});
}
async function placeOrder(e){e.preventDefault();const error=validateCheckout();if(error){showToast(error);return}const btn=$('placeOrderBtn');btn.disabled=true;btn.textContent='Placing order…';const payload={customer_name:$('customerName').value.trim(),customer_phone:$('customerPhone').value.replace(/\D/g,'').slice(-10),customer_address:$('customerAddress').value.trim(),latitude:state.coords?.latitude??null,longitude:state.coords?.longitude??null,items:lines().map(x=>({id:x.item.id,variant_id:x.variant?.id||null,variant:x.variant?.label||null,qty:x.qty}))};try{const r=await fetch(`${API_BASE}/order`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(payload)});const d=await r.json().catch(()=>({}));if(!r.ok||!d.success)throw new Error(d.error||`Order failed (${r.status})`);state.cart.clear();renderMenu();renderCart();closeSheets();$('successText').textContent=`Your Nutri Home order #${d.orderId} has been sent to the restaurant. Total ${money(d.total)}.`;openSheet('successSheet')}catch(err){showToast(err.message||'Could not place order. Please try again.')}finally{btn.disabled=false;btn.textContent='Place Order'}}
$('searchInput').addEventListener('input',e=>{state.search=e.target.value;renderMenu()});$('categories').addEventListener('click',e=>{const b=e.target.closest('[data-cat]');if(!b)return;state.category=b.dataset.cat;renderCategories();renderMenu()});$('menuGrid').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(!b)return;const item=state.menu.find(x=>String(x.id)===String(b.dataset.id));if(!item)return;if(b.dataset.action==='add')addItem(item);else decrementItem(item.id)});$('variantOptions').addEventListener('click',e=>{const b=e.target.closest('[data-variant]');if(!b||!state.selectedItem)return;const v=state.selectedItem.variants[Number(b.dataset.variant)];closeSheets();addResolved(state.selectedItem,v)});$('cartBar').addEventListener('click',()=>{renderCart();openSheet('cartSheet')});$('cartLines').addEventListener('click',e=>{const minus=e.target.closest('[data-cart-minus]'),plus=e.target.closest('[data-cart-plus]');if(minus)decrementKey(minus.dataset.cartMinus);if(plus){const x=state.cart.get(plus.dataset.cartPlus);if(x)addResolved(x.item,x.variant)}});$('checkoutBtn').addEventListener('click',()=>{closeSheets();$('checkoutTotal').textContent=money(cartTotal());openSheet('checkoutSheet')});$('locationBtn').addEventListener('click',useLocation);$('checkoutForm').addEventListener('submit',placeOrder);$('sheetBackdrop').addEventListener('click',closeSheets);document.addEventListener('click',e=>{if(e.target.closest('[data-close]'))closeSheets()});$('doneBtn').addEventListener('click',closeSheets);
let installPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('installBtn').classList.remove('hidden')});$('installBtn').addEventListener('click',async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('installBtn').classList.add('hidden')});window.addEventListener('appinstalled',()=>{$('installBtn').classList.add('hidden');showToast('Nutri Home installed.')});
if('serviceWorker'in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/order/sw.js').catch(()=>{}))}
loadMenu();
