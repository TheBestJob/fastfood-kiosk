import {apply} from './demo.js';

const live = document.querySelector('meta[name="local-server"]') !== null;
const key = 'counter-club-v1';
const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const seed = await fetch('./seed.json').then(response => response.json());
const getDemo = () => JSON.parse(localStorage.getItem(key)) || structuredClone(seed);
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2,'0')).join('');
const money = cents => new Intl.NumberFormat('en-IE', {style:'currency',currency:'PLN'}).format(cents / 100);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const view = () => location.hash.slice(1).split('/')[0] || 'kiosk';
let state;
let basket = {};
let orderId = uid();
let editing = null;
let busy = false;
let seenCall;
let stateScreen;
let sound;
let localPin = sessionStorage.getItem('counter-club-pin') || '';
const headers = () => ({'Content-Type':'application/json','X-Staff-Pin':localPin});

document.querySelector('#mode').textContent = live ? 'Shop network' : 'Interactive demo';
const button = (label, action, value = '', style = '') => '<button type="button" class="' + style + '" data-action="' + action + '" data-value="' + esc(value) + '">' + label + '</button>';
const intro = (title, text) => '<section class="intro"><h1>' + title + '</h1><p>' + text + '</p></section>';
const empty = text => '<p class="muted">' + text + '</p>';
const lines = order => '<ul>' + order.items.map(line => '<li>' + line.quantity + ' × ' + esc(line.name) + (line.note ? ' <small>· ' + esc(line.note) + '</small>' : '') + '</li>').join('') + '</ul>';

let refreshVersion = 0;
async function refresh() {
  const version = ++refreshVersion;
  if (live) {
    const response = await fetch('./api/state?screen=' + encodeURIComponent(view()), {headers:headers(),cache:'no-store'});
    if (version !== refreshVersion) return;
    if (response.status === 401) { state = null; stateScreen = view(); draw(); return; }
    if (!response.ok) throw Error('Could not reach the shop server.');
    const next = await response.json();
    if (version !== refreshVersion) return;
    state = next;
  } else state = getDemo();
  stateScreen = view();
  draw();
}
async function commit(action) {
  if (live) {
    const response = await fetch('./api/actions', {method:'POST', headers:headers(), body:JSON.stringify(action)});
    const result = await response.json();
    if (!response.ok) throw Error(typeof result.detail === 'string' ? result.detail : 'Check the submitted values and try again.');
    return result;
  }
  const save = () => {
    const next = getDemo();
    const result = apply(next, action);
    localStorage.setItem(key, JSON.stringify(next));
    return result;
  };
  return navigator.locks ? navigator.locks.request(key, save) : save();
}

function kiosk() {
  const items = state.menu.filter(item => item.active);
  const subtotal = Object.entries(basket).reduce((sum,[id,line]) => sum + (items.find(item => item.id === id)?.price || 0) * line.quantity,0);
  const discount = Math.round(subtotal * state.offer.percent / 100);
  const cards = items.map(item => '<article class="card"><span class="category">' + esc(item.category) + '</span><h3>' + esc(item.name) + '</h3><p class="muted">' + esc(item.description) + '</p><div class="row"><strong>' + money(item.price) + '</strong>' + button('Add to order','add',item.id) + '</div></article>').join('');
  const cart = Object.entries(basket).map(([id,line]) => {
    const item = state.menu.find(entry => entry.id === id);
    return '<div class="line"><div class="row"><strong>' + esc(item?.name || 'Unavailable item') + '</strong><span>' + (item?.active ? money(item.price * line.quantity) : 'Sold out') + '</span></div><div class="actions">' + button('−','minus',id,'secondary') + '<span>' + line.quantity + '</span>' + button('+','add',id,'secondary') + '</div><label>Item notes<input maxlength="140" data-note="' + esc(id) + '" value="' + esc(line.note) + '" placeholder="E.g. no pickles"></label></div>';
  }).join('');
  const unavailable = Object.keys(basket).some(id => !items.some(item => item.id === id));
  return intro('What are you having?', 'Build your order here, then pay at the counter.') +
    (state.offer.percent ? '<div class="panel ready">' + esc(state.offer.name) + ' · ' + state.offer.percent + '% off</div>' : '') +
    '<div class="layout"><div class="cards">' + (cards || empty('The menu is currently closed.')) + '</div><aside class="panel"><h2>Your order</h2>' +
    (cart || empty('Your basket is empty.')) + (discount ? '<p>Discount ' + money(discount) + '</p>' : '') +
    '<div class="row line"><strong>Total</strong><strong>' + money(subtotal - discount) + '</strong></div><button class="primary" data-action="place"' +
    (!cart || unavailable || busy ? ' disabled' : '') + '>Place order</button></aside></div>';
}

function receipt() {
  const order = JSON.parse(sessionStorage.getItem('counter-club-receipt') || 'null');
  if (!order) return kiosk();
  return '<section class="intro"><h1>Order placed</h1></section><article class="panel receipt"><div class="token">' + esc(order.token) +
    '</div><p>Pay at counter</p>' + lines(order) + (order.discount ? '<p>Discount ' + money(order.discount) + '</p>' : '') +
    '<strong>Total ' + money(order.total) + '</strong><p>Order confirmation</p><div class="actions no-print">' +
    button('Print slip','print','','secondary') + '<a class="button" href="#kiosk">Start a new order</a></div></article>';
}

function ticket(order, counter) {
  const status = (label, status) => button(label,'status',order.id + ':' + status);
  let actions = '';
  if (!counter && order.status === 'Queued') actions += status('Start preparing','Preparing');
  if (!counter && order.status === 'Preparing') actions += status('Mark ready','Ready');
  if (counter && order.status === 'Ready') {
    actions += button('Call token','call',order.id);
    if (order.payment) actions += status('Mark collected','Collected');
  }
  if (counter && !order.payment && ['Queued','Preparing','Ready'].includes(order.status)) {
    actions += button('Paid cash','pay',order.id + ':Cash','secondary') + button('Paid by card','pay',order.id + ':Card','secondary') + status('Cancel','Cancelled');
  }
  if (counter && state.printers?.slip) actions += button('Reprint slip','reprint',order.id + ':slip','secondary');
  if (counter && state.printers?.kitchen) actions += button('Reprint KOT','reprint',order.id + ':kitchen','secondary');
  return '<article class="panel"><div class="row"><h2>' + esc(order.token) + '</h2><strong>' + esc(order.status) + '</strong></div>' + lines(order) +
    (counter ? '<p><strong>' + money(order.total) + '</strong> · ' + (order.payment ? esc(order.payment.method) + ' paid' : 'Unpaid') + '</p>' : '') +
    '<div class="actions">' + actions + '</div></article>';
}

function owner() {
  const item = state.menu.find(entry => entry.id === editing);
  const active = state.orders.filter(order => !['Collected','Cancelled'].includes(order.status));
  const closed = state.orders.filter(order => ['Collected','Cancelled'].includes(order.status)).slice(0,30);
  const today = new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Warsaw'});
  const sales = state.orders.filter(order => order.payment && new Date(order.payment.at).toLocaleDateString('en-CA',{timeZone:'Europe/Warsaw'}) === today);
  return intro('Counter', 'Payments, menu availability and the orders in service.') +
    '<section class="panel"><div class="row"><div><h2>Today’s sales</h2><strong>' + money(sales.reduce((sum,order) => sum + order.total,0)) +
    '</strong> · ' + sales.length + ' paid orders</div>' + button('Export orders CSV','export','','secondary') + '</div></section>' +
    (state.printIssues?.length ? '<section class="panel"><h2>Print jobs needing attention</h2>' +
    state.printIssues.map(job => '<p>' + esc(job.token) + ' · ' + esc(job.kind) + ' · ' + esc(job.status) + '</p>').join('') + '</section>' : '') +
    '<h2>Live orders</h2><div class="columns">' + (active.map(order => ticket(order,true)).join('') || empty('No open orders.')) + '</div>' +
    '<div class="layout"><section class="panel"><h2>Menu</h2>' + state.menu.map(entry => '<div class="row line"><span><strong>' + esc(entry.name) +
    '</strong> · ' + money(entry.price) + (entry.active ? '' : ' · Sold out') + '</span><div class="actions">' +
    button(entry.active ? 'Mark sold out' : 'Make available','toggle',entry.id,'secondary') + button('Edit','edit',entry.id,'secondary') + '</div></div>').join('') +
    '<form id="menu-form"><h3>' + (item ? 'Edit item' : 'Add menu item') + '</h3><div class="row"><label>Name<input required name="name" maxlength="80" value="' + esc(item?.name) +
    '"></label><label>Category<input required name="category" maxlength="40" value="' + esc(item?.category) + '"></label><label>Price (PLN)<input required name="price" type="number" min="0.01" max="999.99" step="0.01" value="' +
    (item ? (item.price / 100).toFixed(2) : '') + '"></label><label>Description<input name="description" maxlength="200" value="' + esc(item?.description) + '"></label><button>Save item</button>' +
    (item ? button('Cancel edit','edit','','secondary') : '') + '</div></form></section>' +
    '<section class="panel"><h2>Promotion</h2><form id="offer-form"><label>Offer name<input name="name" maxlength="80" value="' + esc(state.offer.name) +
    '"></label><label>Discount (%)<input name="percent" required type="number" min="0" max="90" value="' + state.offer.percent +
    '"></label><div class="actions"><button>Save promotion</button>' + button('End promotion','end-offer','','secondary') + '</div></form></section></div>' +
    '<h2>Recent closed orders</h2><div class="columns">' + (closed.map(order => ticket(order,true)).join('') || empty('No closed orders.')) + '</div>';
}

function display() {
  const tokens = status => state.orders.filter(order => order.status === status).map(order => '<div class="token">' + esc(order.token) + '</div>').join('');
  return intro('Order pickup', 'Pay and collect at the counter when your number is called.') +
    (state.call ? '<div class="call" aria-live="polite">Now calling<div class="token">' + esc(state.call.token) + '</div></div>' : '') +
    '<div class="columns"><section class="panel"><h2>Preparing</h2>' + (tokens('Preparing') || empty('—')) + '</section><section class="panel ready"><h2>Ready</h2>' +
    (tokens('Ready') || empty('—')) + '</section></div>' + button(sound ? 'Chime enabled' : 'Enable call chime','sound','','secondary');
}

function draw(force = false) {
  const screen = view();
  if (live && screen !== stateScreen) return;
  // Live refreshes should preserve form fields staff are currently editing.
  if (!force && app.dataset.view === screen && document.activeElement?.matches('#menu-form input, #offer-form input, [data-note]')) return;
  app.dataset.view = screen;
  for (const link of document.querySelectorAll('nav a')) {
    if (link.hash === '#' + screen) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  }
  if (!state) {
    app.innerHTML = intro('Staff access','Enter the PIN configured on this shop’s server.') +
      '<form id="pin-form" class="panel"><label>Staff PIN<input type="password" required name="pin" inputmode="numeric"></label><div class="actions"><button>Unlock</button></div></form>';
    return;
  }
  if (screen === 'owner') app.innerHTML = owner();
  else if (screen === 'kitchen') {
    const open = state.orders.filter(order => ['Queued','Preparing'].includes(order.status)).reverse();
    app.innerHTML = intro('Kitchen tickets','Prepare orders from oldest to newest.') + '<div class="columns">' +
      (open.map(order => ticket(order,false)).join('') || empty('Waiting for the next order.')) + '</div>';
  } else if (screen === 'display') {
    app.innerHTML = display();
    if (sound && state.call && state.call.id !== seenCall) {
      const tone = sound.createOscillator();
      const gain = sound.createGain();
      tone.frequency.value = 660;
      gain.gain.value = 0.12;
      tone.connect(gain).connect(sound.destination);
      tone.start();
      tone.stop(sound.currentTime + 0.23);
    }
    seenCall = state.call?.id;
  } else app.innerHTML = location.hash === '#kiosk/receipt' ? receipt() : kiosk();
}

async function perform(operation) {
  if (busy) return;
  busy = true;
  notice.textContent = '';
  try { await operation(); await refresh(); }
  catch (error) { notice.textContent = error.message; }
  finally { busy = false; draw(true); }
}

app.addEventListener('input', event => {
  const note = event.target.dataset.note;
  if (note && basket[note]) basket[note].note = event.target.value;
});
app.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control || busy) return;
  const {action, value} = control.dataset;
  if (action === 'print') { window.print(); return; }
  if (action === 'sound') {
    sound ||= new AudioContext();
    sound.resume();
    draw(true);
    return;
  }
  if (action === 'edit') { editing = value; draw(true); return; }
  if (action === 'export') {
    const escapeCell = value => '"' + String(value ?? '').replaceAll('"','""') + '"';
    const rows = [['Token','Created','Status','Payment','Paid at','Total PLN'], ...state.orders.map(order =>
      [order.token,order.createdAt,order.status,order.payment?.method,order.payment?.at,(order.total / 100).toFixed(2)])];
    const url = URL.createObjectURL(new Blob([rows.map(row => row.map(escapeCell).join(',')).join('\r\n')],{type:'text/csv'}));
    const link = Object.assign(document.createElement('a'),{href:url,download:'counter-club-orders.csv'});
    link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
    return;
  }
  if (action === 'add' || action === 'minus') {
    basket[value] ||= {id:value,quantity:0,note:''};
    basket[value].quantity = Math.min(30,basket[value].quantity + (action === 'add' ? 1 : -1));
    if (basket[value].quantity <= 0) delete basket[value];
    draw(true);
    return;
  }
  perform(async () => {
    const [id, argument] = value.split(':');
    if (action === 'place') {
      control.disabled = true;
      const items = Object.values(basket);
      const subtotal = items.reduce((total,line) => total + (state.menu.find(item => item.id === line.id)?.price || 0) * line.quantity,0);
      const expectedTotal = subtotal - Math.round(subtotal * state.offer.percent / 100);
      const result = await commit({type:'place',id:orderId,items,expectedTotal});
      sessionStorage.setItem('counter-club-receipt',JSON.stringify(result.order));
      basket = {};
      orderId = uid();
      location.hash = 'kiosk/receipt';
    } else if (action === 'toggle') {
      const item = state.menu.find(entry => entry.id === id);
      await commit({type:'menu',item:{...item,active:!item.active}});
    } else if (action === 'end-offer') {
      await commit({type:'offer',offer:{name:'',percent:0}});
    } else {
      if (action === 'status' && argument === 'Cancelled' && !confirm('Cancel this order?')) return;
      await commit({type:action,id,status:action === 'status' ? argument : undefined,
        method:action === 'pay' ? argument : undefined,callId:action === 'reprint' ? argument : uid()});
      if (action === 'reprint') notice.textContent = 'Reprint queued.';
    }
  });
});
app.addEventListener('submit', event => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.target));
  perform(async () => {
    if (event.target.id === 'pin-form') {
      localPin = fields.pin;
      sessionStorage.setItem('counter-club-pin',localPin);
    } else if (event.target.id === 'menu-form') {
      const current = state.menu.find(item => item.id === editing);
      await commit({type:'menu',item:{...fields,id:current?.id || uid(),price:Math.round(Number(fields.price)*100),active:current?.active ?? true}});
      editing = null;
    } else if (event.target.id === 'offer-form') {
      await commit({type:'offer',offer:{name:fields.name,percent:Number(fields.percent)}});
    }
  });
});
const sync = () => refresh().catch(error => { notice.textContent = error.message; });
window.addEventListener('hashchange', () => { notice.textContent = ''; sync(); });
window.addEventListener('storage', event => { if (!live && event.key === key) sync(); });
if (live) {
  const events = new EventSource('./api/events');
  events.addEventListener('change', sync);
  events.addEventListener('open', sync);
}
await sync();
