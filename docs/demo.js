export function apply(state, action) {
  if (action.type === 'place') {
    const existing = state.orders.find(order => order.id === action.id);
    if (existing) return {order: existing};
    if (!action.items.length) throw Error('Add an item before ordering.');
    const items = action.items.map(line => {
      const item = state.menu.find(entry => entry.id === line.id && entry.active);
      if (!item) throw Error('An item sold out. Update your basket and try again.');
      return {name: item.name, price: item.price, quantity: line.quantity, note: line.note};
    });
    const subtotal = items.reduce((total, item) => total + item.price * item.quantity, 0);
    const discount = Math.round(subtotal * state.offer.percent / 100);
    if (subtotal - discount !== action.expectedTotal) throw Error('The price changed. Review your basket.');
    const order = {
      id: action.id, token: 'A' + String(state.next++).padStart(3, '0'),
      items, subtotal, discount, offer: state.offer.name, total: subtotal - discount,
      status: 'Queued', payment: null, createdAt: new Date().toISOString()
    };
    state.orders.unshift(order);
    return {order};
  }
  if (action.type === 'menu') {
    const index = state.menu.findIndex(item => item.id === action.item.id);
    if (index < 0) state.menu.push(action.item);
    else state.menu[index] = action.item;
    return {};
  }
  if (action.type === 'offer') {
    state.offer = action.offer;
    return {};
  }
  const order = state.orders.find(item => item.id === action.id);
  if (!order) throw Error('Order unavailable.');
  if (action.type === 'pay' && ['Queued','Preparing','Ready'].includes(order.status) && !order.payment) {
    order.payment = {method: action.method, at: new Date().toISOString()};
  } else if (action.type === 'call' && order.status === 'Ready') {
    state.call = {token: order.token, id: action.callId};
  } else if (action.type === 'status') {
    const next = {Queued:['Preparing','Cancelled'], Preparing:['Ready','Cancelled'], Ready:['Collected','Cancelled']};
    if (!next[order.status]?.includes(action.status) ||
        (action.status === 'Collected' && !order.payment) ||
        (action.status === 'Cancelled' && order.payment)) throw Error('This order cannot make that change.');
    order.status = action.status;
    if (state.call?.token === order.token && order.status !== 'Ready') state.call = null;
  } else {
    throw Error('This order cannot make that change.');
  }
  return {};
}
