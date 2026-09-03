const API_BASE=location.origin,FALLBACK='/order/icons/icon-512.png';
const $=id=>document.getElementById(id),esc=(s='')=>String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])),money=n=>`₹${Math.round(Number(n)||0)}`;
const state={menu:[],category:'All',search:'',cart:new Map(),selectedItem:null,selectedVariant:null,coords:null,token:localStorage.getItem('nh_customer_token')||'',phone:localStorage.getItem('nh_customer_phone')||'',orders:[],reviewTarget:null,reviewRating:0,otpTimer:null,otpRetryAfter:60,tracking:null,trackings:[],sessionActiveOrders:[],selectedOrderSource:'token',trackingTimer:null,homeTrackingTimer:null,lastTrackedStatus:null,msg91Ready:false,msg91Loading:null};
function imageUrl(v){if(!v)return FALLBACK;v=String(v).trim();return /^https?:\/\//i.test(v)?v:`${API_BASE}${v.startsWith('/')?'':'/'}${v}`}
function lines(){return[...state.cart.values()].filter(x=>x.qty>0)}function cartQty(){return lines().reduce((s,x)=>s+x.qty,0)}function cartTotal(){return lines().reduce((s,x)=>s+x.qty*Number(x.price),0)}
function keyFor(i,v){return`${i.id}::${v?.id||v?.label||'base'}`}function qtyForItem(id){return lines().filter(x=>Number(x.item.id)===Number(id)).reduce((s,x)=>s+x.qty,0)}
function toast(m){const t=$('toast');t.textContent=m;t.classList.remove('hidden');clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.add('hidden'),3000)}
function openSheet(id){$('sheetBackdrop').classList.remove('hidden');$(id).classList.remove('hidden');document.body.style.overflow='hidden'}
function closeSheets(){document.querySelectorAll('.sheet').forEach(x=>x.classList.add('hidden'));$('sheetBackdrop').classList.add('hidden');document.body.style.overflow='';clearInterval(state.trackingTimer);state.trackingTimer=null}
function authHeaders(){return state.token?{Authorization:`Bearer ${state.token}`}:{}}
function persistTrackings(){
  localStorage.setItem('nh_active_trackings',JSON.stringify(state.trackings.map(x=>({orderId:Number(x.orderId),token:String(x.token)}))));
  if(state.trackings[0])localStorage.setItem('nh_last_tracking',JSON.stringify(state.trackings[0]));
}
function saveTracking(orderId,token){
  if(!orderId||!token)return;
  const data={orderId:Number(orderId),token:String(token)};
  state.trackings=[data,...state.trackings.filter(x=>Number(x.orderId)!==data.orderId)].slice(0,10);
  state.tracking=data;
  persistTrackings();
  startHomeTracking();
}
function loadSavedTracking(){
  try{
    const list=JSON.parse(localStorage.getItem('nh_active_trackings')||'[]');
    if(Array.isArray(list))state.trackings=list.filter(x=>x?.orderId&&x?.token).map(x=>({orderId:Number(x.orderId),token:String(x.token)}));
  }catch(_){}
  // Backward compatibility: migrate the old single-order key into the new list.
  try{
    const old=JSON.parse(localStorage.getItem('nh_last_tracking')||'null');
    if(old?.orderId&&old?.token&&!state.trackings.some(x=>Number(x.orderId)===Number(old.orderId))){
      state.trackings.unshift({orderId:Number(old.orderId),token:String(old.token)});
    }
  }catch(_){}
  state.trackings=state.trackings.slice(0,10);
  state.tracking=state.trackings[0]||null;
  persistTrackings();
}
function trackingSteps(status){
  if(status==='CANCELLED')return[];
  return ['NEW','ACCEPTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED'];
}
function trackingLabel(s){return({NEW:'Order placed',ACCEPTED:'Order accepted',PREPARING:'Preparing your food',READY:'Ready for pickup',OUT_FOR_DELIVERY:'Out for delivery',DELIVERED:'Delivered',CANCELLED:'Order cancelled'})[s]||s}
function trackingSub(s){return({NEW:'Nutri Home has received your order.',ACCEPTED:'Your order has been confirmed by the kitchen.',PREPARING:'The kitchen is preparing your order now.',READY:'Your order is packed and ready.',OUT_FOR_DELIVERY:'Your order is on the way to you.',DELIVERED:'Your order has been delivered. Enjoy your meal!',CANCELLED:'This order will not be processed.'})[s]||'Live order update'}
function trackingIcon(s){return({NEW:'✓',ACCEPTED:'✓',PREPARING:'◷',READY:'✓',OUT_FOR_DELIVERY:'→',DELIVERED:'✓',CANCELLED:'!'})[s]||'•'}
function statusProgress(status){
  const steps=['NEW','ACCEPTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED'];
  if(status==='CANCELLED')return 100;
  const idx=Math.max(0,steps.indexOf(status));
  return Math.round(((idx+1)/steps.length)*100);
}
function mergeHomeOrders(tokenOrders, sessionOrders){
  const byId=new Map();
  for(const o of tokenOrders||[])byId.set(Number(o.id),{...o,_source:'token'});
  for(const o of sessionOrders||[]){
    const id=Number(o.id);
    if(byId.has(id))byId.set(id,{...byId.get(id),...o,_source:'session'});
    else byId.set(id,{...o,_source:'session'});
  }
  return [...byId.values()].sort((a,b)=>Number(b.id)-Number(a.id));
}
function renderHomeOrders(orders){
  const wrap=$('homeOrdersStatus'),list=$('homeOrdersList');
  if(!orders?.length){wrap.classList.add('hidden');list.innerHTML='';return}
  wrap.classList.remove('hidden');
  const active=orders.filter(o=>!['DELIVERED','CANCELLED'].includes(o.status));
  $('homeOrdersCount').textContent=`${active.length||orders.length} ${active.length===1?'active order':'active orders'}`;
  list.innerHTML=orders.map(o=>`<button class="home-live-card ${o.status==='CANCELLED'?'cancelled':''}" type="button" data-live-order="${o.id}" data-order-source="${o._source||'token'}">
    <div class="home-live-top"><span class="live-pill"><span class="live-dot"></span>${['DELIVERED','CANCELLED'].includes(o.status)?' ORDER':' LIVE ORDER'}</span><span class="home-live-order">Order #${o.id}</span></div>
    <div class="home-live-status-row"><div class="home-live-status-copy"><div class="home-live-status">${esc(trackingLabel(o.status))}</div><div class="home-live-hint">${o.status==='DELIVERED'?'Tap to view receipt & details':o.status==='CANCELLED'?'Tap to view order details':'Tap to view live order details'}</div></div><div class="home-live-arrow">›</div></div>
    <div class="home-live-track"><span style="width:${statusProgress(o.status)}%"></span></div>
  </button>`).join('');
}
async function fetchTracking(ref){
  const u=`${API_BASE}/order-track?order_id=${encodeURIComponent(ref.orderId)}&token=${encodeURIComponent(ref.token)}&t=${Date.now()}`;
  const r=await fetch(u,{cache:'no-store'});
  const d=await r.json();
  if(!r.ok)throw Error(d.error||'Could not track order');
  return d;
}
async function fetchSessionActiveOrders(){
  if(!state.token)return [];
  const r=await fetch(`${API_BASE}/customer/active-orders?t=${Date.now()}`,{headers:authHeaders(),cache:'no-store'});
  if(r.status===401)return [];
  const d=await r.json();
  if(!r.ok)throw Error(d.error||'Could not load active orders');
  return Array.isArray(d)?d:[];
}
async function fetchSessionOrder(orderId){
  const r=await fetch(`${API_BASE}/customer/order/${encodeURIComponent(orderId)}?t=${Date.now()}`,{headers:authHeaders(),cache:'no-store'});
  const d=await r.json();
  if(!r.ok)throw Error(d.error||'Could not load order');
  return d;
}

async function refreshHomeOrders(){
  const tokenResults=await Promise.all(state.trackings.map(async ref=>{
    try{return {ref,data:await fetchTracking(ref)}}catch(_){return null}
  }));
  const valid=tokenResults.filter(Boolean);
  state.trackings=valid.map(x=>x.ref);
  persistTrackings();

  const tokenOrders=valid.map(x=>x.data);
  try{
    state.sessionActiveOrders=await fetchSessionActiveOrders();
  }catch(_){
    state.sessionActiveOrders=[];
  }

  const orders=mergeHomeOrders(tokenOrders,state.sessionActiveOrders);
  renderHomeOrders(orders);

  if(state.tracking){
    const selected=orders.find(o=>Number(o.id)===Number(state.tracking.orderId));
    if(selected)state.lastTrackedStatus=selected.status;
  }

  const hasActive=orders.some(o=>!['DELIVERED','CANCELLED'].includes(o.status));
  if(!hasActive){
    clearInterval(state.homeTrackingTimer);
    state.homeTrackingTimer=null;
  }
}
function startHomeTracking(){
  clearInterval(state.homeTrackingTimer);
  state.homeTrackingTimer=null;
  if(!state.trackings.length&&!state.token){renderHomeOrders([]);return}
  refreshHomeOrders();
  state.homeTrackingTimer=setInterval(refreshHomeOrders,8000);
}

async function loadTracking(showSheet=true){
  if(!state.tracking)return toast('No order available to track');
  if(showSheet)openSheet('trackingSheet');
  $('trackingTitle').textContent=`Order #${state.tracking.orderId}`;
  $('trackingStatus').innerHTML='<div class="state-card">Checking order status…</div>';
  try{
    let d;
    if(state.selectedOrderSource==='session'&&state.token){
      d=await fetchSessionOrder(state.tracking.orderId);
    }else{
      d=await fetchTracking(state.tracking);
    }
    renderTracking(d);
    refreshHomeOrders();
    clearInterval(state.trackingTimer);
    if(!['DELIVERED','CANCELLED'].includes(d.status)){
      state.trackingTimer=setInterval(()=>loadTracking(false),8000);
    }
  }catch(e){$('trackingStatus').innerHTML=`<div class="state-card">${esc(e.message)}</div>`}
}
function renderTracking(o){
  const steps=trackingSteps(o.status),idx=steps.indexOf(o.status);
  $('trackingUpdated').textContent=`Updated just now • Current status`;
  $('trackingHeroIcon').textContent=trackingIcon(o.status);
  $('trackingHeroStatus').textContent=trackingLabel(o.status);
  $('trackingHeroSub').textContent=trackingSub(o.status);
  if(o.status==='CANCELLED'){
    $('trackingStatus').innerHTML='<div class="tracking-cancelled">This order has been cancelled.</div>';
  }else{
    $('trackingStatus').innerHTML=steps.map((s,i)=>{
      const cls=i<idx?'done':i===idx?'current':'';
      return `<div class="tracking-step ${cls}"><div class="tracking-dot">${i<idx?'✓':i+1}</div><div><div class="tracking-label">${trackingLabel(s)}</div>${i===idx?'<div class="tracking-note">Current status</div>':''}</div></div>`;
    }).join('')+(o.status==='DELIVERED'?'<div class="tracking-delivered">Your order has been delivered. Thank you!</div>':'');
  }
  const items=Array.isArray(o.items)?o.items:[];
  $('trackingItems').innerHTML=items.map(x=>`<div class="tracking-item"><span>${x.qty||1}× ${esc(x.name)}${x.variant?` • ${esc(x.variant)}`:''}</span><strong>${money((Number(x.price)||0)*(Number(x.qty)||1))}</strong></div>`).join('')+`<div class="tracking-total"><span>Total</span><strong>${money(o.total)}</strong></div>`;
}
function updateAccountButton(){$('accountBtn').textContent=state.token?'My Account':'Login'}
async function loadMenu(){try{const r=await fetch(`${API_BASE}/menu`,{cache:'no-store'});if(!r.ok)throw Error('Menu could not be loaded');state.menu=await r.json();renderCategories();renderMenu()}catch(e){$('menuGrid').innerHTML=`<div class="state-card">${esc(e.message)}</div>`}}
function renderCategories(){const cats=['All',...new Set(state.menu.map(x=>x.category).filter(Boolean))];$('categories').innerHTML=cats.map(c=>`<button class="chip ${state.category===c?'active':''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}
function renderMenu(){const q=state.search.trim().toLowerCase();const items=state.menu.filter(i=>(state.category==='All'||i.category===state.category)&&(!q||`${i.name} ${i.description||''}`.toLowerCase().includes(q)));$('menuGrid').innerHTML=items.map(i=>{const vs=Array.isArray(i.variants)?i.variants:[],min=vs.length?Math.min(...vs.map(v=>Number(v.price)||Infinity)):Number(i.price||0),qty=qtyForItem(i.id),rc=Number(i.rating_count||0),ra=Number(i.rating_avg||0);return`<article class="menu-card"><div class="food-image-wrap"><img class="food-image" src="${esc(imageUrl(i.image))}" onerror="this.src='${FALLBACK}'"><span class="veg-dot">●</span></div><div class="food-body"><div class="food-cat">${esc(i.category||'Menu')}</div><div class="food-name">${esc(i.name)}</div><div class="rating-line">${rc?`<span class="rating-badge">★ ${ra.toFixed(1)}</span><span>${rc} rating${rc===1?'':'s'}</span>`:`<span class="no-rating">New • Not rated yet</span>`}</div>${i.description?`<div class="food-description">${esc(i.description)}</div>`:''}${vs.length?`<div class="customisable">Customisable • ${vs.length} size/quantity options</div>`:''}<div class="food-bottom"><div class="price">${vs.length?'From ':''}${money(min)}</div>${qty?`<div class="qty-control"><button data-action="minus" data-id="${i.id}">−</button><span>${qty}</span><button data-action="add" data-id="${i.id}">+</button></div>`:`<button class="add-btn" data-action="add" data-id="${i.id}">ADD</button>`}</div></div></article>`}).join('')||'<div class="state-card">No matching items found.</div>';renderCartBar()}
function renderCartBar(){$('cartQty').textContent=cartQty();$('cartTotal').textContent=money(cartTotal());$('cartBar').classList.toggle('hidden',!cartQty())}
function addResolved(item,variant=null){const k=keyFor(item,variant),old=state.cart.get(k);state.cart.set(k,{item,variant,price:Number(variant?.price??item.price??0),qty:(old?.qty||0)+1});renderMenu();renderCart()}
function addItem(item){const vs=Array.isArray(item.variants)?item.variants:[];if(!vs.length)return addResolved(item);state.selectedItem=item;state.selectedVariant=null;$('variantTitle').textContent=item.name;$('variantDescription').textContent=item.description||'Choose one quantity / size';$('variantOptions').innerHTML=vs.map((v,idx)=>`<button class="variant-option" data-variant="${idx}"><span class="variant-left"><span class="variant-radio"></span><strong>${esc(v.label)}</strong></span><strong>${money(v.price)}</strong></button>`).join('');$('variantAddBtn').disabled=true;$('variantAddBtn').textContent='Choose an option';openSheet('variantSheet')}
function renderVariantSelection(){$('variantOptions').querySelectorAll('.variant-option').forEach((b,i)=>b.classList.toggle('selected',state.selectedVariant===i));const v=state.selectedItem?.variants?.[state.selectedVariant];$('variantAddBtn').disabled=!v;$('variantAddBtn').textContent=v?`Add Item • ${money(v.price)}`:'Choose an option'}
function decrementKey(k){const x=state.cart.get(k);if(!x)return;x.qty--;if(x.qty<=0)state.cart.delete(k);renderMenu();renderCart()}
function decrementItem(id){const e=[...state.cart.entries()].find(([,x])=>Number(x.item.id)===Number(id));if(e)decrementKey(e[0])}
function renderCart(){const ls=lines();$('cartLines').innerHTML=ls.length?ls.map(x=>{const k=keyFor(x.item,x.variant);return`<div class="cart-line"><div><div class="line-name">${esc(x.item.name)}</div>${x.variant?`<div class="line-variant">${esc(x.variant.label)}</div>`:''}</div><div class="line-right"><strong>${money(x.price*x.qty)}</strong><div class="mini-qty"><button data-minus="${esc(k)}">−</button><span>${x.qty}</span><button data-plus="${esc(k)}">+</button></div></div></div>`}).join(''):'<div class="state-card">Your cart is empty.</div>';$('sheetTotal').textContent=money(cartTotal());$('checkoutTotal').textContent=money(cartTotal());$('checkoutBtn').disabled=!ls.length}
async function useLocation(){if(!navigator.geolocation)return toast('Location is not supported');$('locationStatus').textContent='Getting GPS and address…';navigator.geolocation.getCurrentPosition(async p=>{state.coords={latitude:p.coords.latitude,longitude:p.coords.longitude};try{const r=await fetch(`${API_BASE}/reverse-geocode?lat=${p.coords.latitude}&lng=${p.coords.longitude}&t=${Date.now()}`,{cache:'no-store'});const d=await r.json();if(d.address)$('customerAddress').value=d.address;$('locationStatus').textContent=`Location captured • ${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`}catch(_){$('locationStatus').textContent='GPS captured. Please enter address manually.'}},()=>toast('Could not get current location'),{enableHighAccuracy:true,timeout:20000,maximumAge:0})}
async function placeOrder(e){e.preventDefault();const name=$('customerName').value.trim(),phone=$('customerPhone').value.replace(/\D/g,'').slice(-10),address=$('customerAddress').value.trim();if(!name)return toast('Enter your name');if(!/^[6-9]\d{9}$/.test(phone))return toast('Enter a valid mobile number');if(!address)return toast('Enter delivery address');const btn=$('placeOrderBtn');btn.disabled=true;btn.textContent='Placing order…';try{localStorage.setItem('nh_customer_name',name);const payload={customer_name:name,customer_phone:phone,customer_address:address,latitude:state.coords?.latitude??null,longitude:state.coords?.longitude??null,items:lines().map(x=>({id:x.item.id,variant_id:x.variant?.id||null,variant:x.variant?.label||null,qty:x.qty}))};const r=await fetch(`${API_BASE}/order`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok||!d.success)throw Error(d.error||'Order failed');saveTracking(d.orderId,d.trackingToken);state.cart.clear();renderMenu();renderCart();closeSheets();$('successText').textContent=`Order #${d.orderId} • ${money(d.total)} • Status: Order placed`;openSheet('successSheet');if(state.token)loadMyOrders()}catch(err){toast(err.message)}finally{btn.disabled=false;btn.textContent='Place Order'}}
function setAuthMessage(message,type='error'){
  const el=$('authMessage');
  if(!message){el.className='auth-message hidden';el.textContent='';return}
  el.className=`auth-message ${type}`;
  el.textContent=message;
}
function maskLoginPhone(phone){
  const p=String(phone||'');
  return p.length===10?`+91 ••••••${p.slice(-4)}`:`+91 ${p}`;
}
function startOtpCountdown(seconds=60){
  clearInterval(state.otpTimer);
  state.otpRetryAfter=Math.max(1,Number(seconds)||60);
  $('resendOtpBtn').classList.add('hidden');
  $('otpCountdown').classList.remove('hidden');
  const tick=()=>{
    if(state.otpRetryAfter<=0){
      clearInterval(state.otpTimer);state.otpTimer=null;
      $('otpCountdown').classList.add('hidden');$('resendOtpBtn').classList.remove('hidden');return;
    }
    $('otpCountdown').textContent=`You can resend OTP in ${state.otpRetryAfter}s`;state.otpRetryAfter--;
  };
  tick();state.otpTimer=setInterval(tick,1000);
}
function msg91ErrorMessage(error,fallback='OTP service error'){
  if(!error)return fallback;
  if(typeof error==='string')return error;
  return error.message||error.error||error.description||fallback;
}
function findMsg91AccessToken(data,depth=0){
  if(depth>5||data==null)return'';
  if(typeof data==='string')return data.split('.').length===3?data:'';
  if(Array.isArray(data)){for(const x of data){const t=findMsg91AccessToken(x,depth+1);if(t)return t}return''}
  if(typeof data!=='object')return'';
  for(const k of ['access-token','access_token','accessToken','jwt','jwt_token','token']){
    if(typeof data[k]==='string'&&data[k].length>20)return data[k];
  }
  for(const x of Object.values(data)){const t=findMsg91AccessToken(x,depth+1);if(t)return t}
  return'';
}
async function waitForMsg91Methods(timeout=8000){
  const started=Date.now();

  while(Date.now()-started<timeout){
    if(
      typeof window.sendOtp==='function' &&
      typeof window.retryOtp==='function' &&
      typeof window.verifyOtp==='function'
    ){
      return;
    }

    await new Promise(resolve=>setTimeout(resolve,100));
  }

  throw Error('OTP service methods did not initialize');
}

async function ensureMsg91Widget(){
  if(
    state.msg91Ready &&
    typeof window.sendOtp==='function' &&
    typeof window.retryOtp==='function' &&
    typeof window.verifyOtp==='function'
  )return;

  if(state.msg91Loading)return state.msg91Loading;

  state.msg91Loading=(async()=>{
    const r=await fetch(
      `${API_BASE}/customer/otp-widget-config?t=${Date.now()}`,
      {cache:'no-store'}
    );

    const cfg=await r.json();

    if(!r.ok)throw Error(
      cfg.error||'OTP Widget is not configured'
    );

    window.configuration={
      widgetId:cfg.widgetId,
      tokenAuth:cfg.tokenAuth,
      exposeMethods:true,
      captchaRenderId:'msg91Captcha',
      success:()=>{},
      failure:(error)=>console.warn(
        'MSG91 OTP widget:',
        error
      )
    };

    if(typeof window.initSendOTP!=='function'){
      await new Promise((resolve,reject)=>{
        const old=document.querySelector(
          'script[data-msg91-otp-widget]'
        );

        if(old){
          if(typeof window.initSendOTP==='function'){
            resolve();
            return;
          }

          old.addEventListener(
            'load',
            resolve,
            {once:true}
          );

          old.addEventListener(
            'error',
            ()=>reject(
              Error('Could not load OTP service')
            ),
            {once:true}
          );

          return;
        }

        const script=document.createElement('script');
        script.src='https://verify.msg91.com/otp-provider.js';
        script.async=true;
        script.dataset.msg91OtpWidget='1';
        script.onload=resolve;
        script.onerror=()=>reject(
          Error('Could not load OTP service')
        );

        document.head.appendChild(script);
      });
    }

    if(typeof window.initSendOTP!=='function')
      throw Error('OTP service did not initialize');

    window.initSendOTP(window.configuration);

    await waitForMsg91Methods();

    state.msg91Ready=true;
  })();

  try{
    await state.msg91Loading;
  }finally{
    state.msg91Loading=null;
  }
}
async function handleSendOtp(isResend=false){
  const phone=(isResend?state.phone:$('loginPhone').value.replace(/\D/g,'').slice(-10));
  if(!/^[6-9]\d{9}$/.test(phone))return setAuthMessage('Enter a valid 10-digit Indian mobile number');
  const b=isResend?$('resendOtpBtn'):$('sendOtpBtn');b.disabled=true;b.textContent='Sending…';setAuthMessage('');
  try{
    await ensureMsg91Widget();
    state.phone=phone;
    if(isResend){
      await new Promise((resolve,reject)=>window.retryOtp(null,resolve,reject));
    }else{
      await new Promise((resolve,reject)=>window.sendOtp(`91${phone}`,resolve,reject));
    }
    $('otpPhoneLabel').textContent=`OTP sent to ${maskLoginPhone(phone)}`;
    $('loginPhoneStep').classList.add('hidden');$('loginOtpStep').classList.remove('hidden');$('loginOtp').value='';$('loginOtp').focus();
    startOtpCountdown(60);setAuthMessage('OTP sent successfully.','success');
  }catch(e){setAuthMessage(msg91ErrorMessage(e,'OTP could not be sent'))}
  finally{b.disabled=false;b.textContent=isResend?'Resend OTP':'Send OTP'}
}
async function finishWidgetLogin(widgetData){
  const accessToken=findMsg91AccessToken(widgetData);
  if(!accessToken)throw Error('MSG91 verification token was not returned');
  const r=await fetch(`${API_BASE}/customer/widget-login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:state.phone,accessToken})});
  const d=await r.json();if(!r.ok)throw Error(d.error||'Secure login verification failed');
  state.token=d.token;state.phone=d.customer.phone;localStorage.setItem('nh_customer_token',state.token);localStorage.setItem('nh_customer_phone',state.phone);
  updateAccountButton();$('customerPhone').value=state.phone;clearInterval(state.otpTimer);state.otpTimer=null;
  setAuthMessage('Login successful. Loading your orders…','success');await refreshHomeOrders();setTimeout(async()=>{closeSheets();await openAccount();},250);
}
async function handleVerifyOtp(){
  const otp=$('loginOtp').value.replace(/\D/g,'').slice(0,6);if(otp.length<4||otp.length>6)return setAuthMessage('Enter the OTP sent to your mobile.');
  const b=$('verifyOtpBtn');b.disabled=true;b.textContent='Verifying…';setAuthMessage('');
  try{
    await ensureMsg91Widget();
    const data=await new Promise((resolve,reject)=>window.verifyOtp(otp,resolve,reject));
    await finishWidgetLogin(data);
  }catch(e){setAuthMessage(msg91ErrorMessage(e,'OTP verification failed'))}
  finally{b.disabled=false;b.textContent='Verify & Login'}
}
async function openAccount(){if(!state.token)return openSheet('loginSheet');$('accountPhone').textContent=`+91 ${state.phone}`;openSheet('accountSheet');await loadMyOrders()}
async function loadMyOrders(){if(!state.token)return;const box=$('myOrders');box.innerHTML='<div class="state-card">Loading orders…</div>';try{const r=await fetch(`${API_BASE}/customer/orders`,{headers:authHeaders(),cache:'no-store'});const d=await r.json();if(r.status===401){logoutLocal();throw Error('Please login again')}if(!r.ok)throw Error(d.error||'Could not load orders');state.orders=d;renderMyOrders()}catch(e){box.innerHTML=`<div class="state-card">${esc(e.message)}</div>`}}
function renderMyOrders(){const box=$('myOrders');box.innerHTML=state.orders.length?state.orders.map(o=>{const items=Array.isArray(o.items)?o.items:[],reviews=Array.isArray(o.reviews)?o.reviews:[];return`<article class="order-history-card"><div class="order-history-top"><strong>Order #${o.id}</strong><span class="history-status">${esc(o.status)}</span></div><div class="history-items">${items.map(x=>`${x.qty||1}× ${esc(x.name)}${x.variant?` (${esc(x.variant)})`:''}`).join('<br>')}</div><div class="total-row"><span>Total</span><strong>${money(o.total)}</strong></div>${o.status==='DELIVERED'?items.map(x=>{const rr=reviews.find(r=>Number(r.menu_id)===Number(x.id));return`<div class="rate-row"><span>${esc(x.name)}</span>${rr?`<span class="reviewed">★ ${rr.rating} Reviewed</span>`:`<button class="rate-btn" data-rate-order="${o.id}" data-rate-menu="${x.id}" data-rate-name="${esc(x.name)}">Rate item</button>`}</div>`}).join(''):''}</article>`}).join(''):'<div class="state-card">No orders found for this mobile number.</div>'}
function openReview(orderId,menuId,name){state.reviewTarget={orderId:Number(orderId),menuId:Number(menuId),name};state.reviewRating=0;$('reviewItemName').textContent=name;$('reviewText').value='';renderStars();closeSheets();openSheet('reviewSheet')}
function renderStars(){$('stars').innerHTML=[1,2,3,4,5].map(n=>`<button class="star ${n<=state.reviewRating?'active':''}" data-star="${n}">★</button>`).join('');$('submitReviewBtn').disabled=!state.reviewRating}
async function submitReview(){if(!state.reviewTarget||!state.reviewRating)return;const b=$('submitReviewBtn');b.disabled=true;b.textContent='Submitting…';try{const r=await fetch(`${API_BASE}/customer/reviews`,{method:'POST',headers:{...authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({order_id:state.reviewTarget.orderId,menu_id:state.reviewTarget.menuId,rating:state.reviewRating,review:$('reviewText').value.trim()})});const d=await r.json();if(!r.ok)throw Error(d.error||'Could not save review');toast('Thank you for your rating!');closeSheets();await loadMenu();await openAccount()}catch(e){toast(e.message)}finally{b.disabled=false;b.textContent='Submit Review'}}
function logoutLocal(){state.token='';state.phone='';localStorage.removeItem('nh_customer_token');localStorage.removeItem('nh_customer_phone');updateAccountButton()}
async function logout(){try{if(state.token)await fetch(`${API_BASE}/customer/logout`,{method:'POST',headers:authHeaders()})}catch(_){}logoutLocal();closeSheets();toast('Logged out')}
$('searchInput').oninput=e=>{state.search=e.target.value;renderMenu()};$('categories').onclick=e=>{const b=e.target.closest('[data-cat]');if(!b)return;state.category=b.dataset.cat;renderCategories();renderMenu()};$('menuGrid').onclick=e=>{const b=e.target.closest('[data-action]');if(!b)return;const i=state.menu.find(x=>String(x.id)===String(b.dataset.id));if(!i)return;b.dataset.action==='add'?addItem(i):decrementItem(i.id)};$('variantOptions').onclick=e=>{const b=e.target.closest('[data-variant]');if(!b)return;state.selectedVariant=Number(b.dataset.variant);renderVariantSelection()};$('variantAddBtn').onclick=()=>{const v=state.selectedItem?.variants?.[state.selectedVariant];if(!v)return;const i=state.selectedItem;closeSheets();addResolved(i,v)};$('cartBar').onclick=()=>{renderCart();openSheet('cartSheet')};$('cartLines').onclick=e=>{const m=e.target.closest('[data-minus]'),p=e.target.closest('[data-plus]');if(m)decrementKey(m.dataset.minus);if(p){const x=state.cart.get(p.dataset.plus);if(x){x.qty++;renderMenu();renderCart()}}};$('checkoutBtn').onclick=()=>{closeSheets();$('customerName').value=localStorage.getItem('nh_customer_name')||'';$('customerPhone').value=state.phone||'';renderCart();openSheet('checkoutSheet')};$('checkoutForm').onsubmit=placeOrder;$('locationBtn').onclick=useLocation;$('accountBtn').onclick=openAccount;$('sendOtpBtn').onclick=()=>handleSendOtp(false);$('resendOtpBtn').onclick=()=>handleSendOtp(true);$('verifyOtpBtn').onclick=handleVerifyOtp;$('changePhoneBtn').onclick=()=>{clearInterval(state.otpTimer);state.otpTimer=null;setAuthMessage('');$('loginOtpStep').classList.add('hidden');$('loginPhoneStep').classList.remove('hidden');$('loginPhone').value=state.phone||'';$('loginPhone').focus()};$('refreshOrdersBtn').onclick=loadMyOrders;$('logoutBtn').onclick=logout;$('myOrders').onclick=e=>{const b=e.target.closest('[data-rate-order]');if(b)openReview(b.dataset.rateOrder,b.dataset.rateMenu,b.dataset.rateName)};$('stars').onclick=e=>{const b=e.target.closest('[data-star]');if(b){state.reviewRating=Number(b.dataset.star);renderStars()}};$('submitReviewBtn').onclick=submitReview;$('homeOrdersList').onclick=e=>{const b=e.target.closest('[data-live-order]');if(!b)return;const orderId=Number(b.dataset.liveOrder);const ref=state.trackings.find(x=>Number(x.orderId)===orderId);if(ref){state.tracking=ref;state.selectedOrderSource='token'}else if(state.token){state.tracking={orderId};state.selectedOrderSource='session'}else{return}loadTracking(true)};$('trackOrderBtn').onclick=()=>{closeSheets();state.tracking=state.trackings[0]||state.tracking;state.selectedOrderSource='token';loadTracking(true)};$('trackingRefreshBtn').onclick=()=>loadTracking(false);$('doneBtn').onclick=closeSheets;$('sheetBackdrop').onclick=closeSheets;document.addEventListener('click',e=>{if(e.target.closest('[data-close]'))closeSheets()});
let installPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('installBtn').classList.remove('hidden')});$('installBtn').onclick=async()=>{if(installPrompt){installPrompt.prompt();installPrompt=null;$('installBtn').classList.add('hidden')}};if('serviceWorker'in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('/order/sw.js'));
loadSavedTracking();updateAccountButton();loadMenu();startHomeTracking();

document.addEventListener('visibilitychange',()=>{if(!document.hidden)startHomeTracking()});

$('loginOtp').addEventListener('keydown',e=>{if(e.key==='Enter')handleVerifyOtp()});
