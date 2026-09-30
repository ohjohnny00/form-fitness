import { createHmac, timingSafeEqual } from 'node:crypto';
import { contacts, password, startDate, cents, imageData, today, HttpError, fail } from './validation.js';
import { loadStore, saveStore, newId, token, digest, passwordHash, passwordMatches } from './local-store.js';

const send = (res, status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
const addDays = (day, count) => { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10); };
const now = () => new Date().toISOString();
const validGoals = ['Improve fitness', 'Build strength', 'Stay consistent', 'Manage weight'];
const viewUser = profile => ({ id: profile.id, memberId: profile.id, role: profile.role, name: profile.name, email: profile.email, workspace: 'local' });
const viewPlan = plan => ({ id: plan.id, name: plan.name, price: plan.price_cents / 100, priceCents: plan.price_cents, available: plan.available, days: plan.days, desc: plan.description, features: plan.features, tag: plan.id === 'plus' ? 'YOUR NEXT LEVEL' : 'YOUR FITNESS JOURNEY' });
const viewPayment = payment => ({ id: payment.id, invoiceId: payment.invoice_id, memberId: payment.member_id, amount: payment.amount_cents / 100, amountCents: payment.amount_cents, method: payment.method, reference: payment.reference, date: payment.payment_date });

function localOrigin(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) fail('This workspace is available only on this computer.', 403);
  return `http://${host}`;
}

async function readBody(req) {
  if (!req.headers['content-type']?.includes('application/json')) fail('Use a JSON request.', 415);
  let body = req.body;
  if (body === undefined) {
    const chunks = []; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 1900000) fail('Upload is too large.', 413); chunks.push(chunk); }
    body = Buffer.concat(chunks).toString();
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString()); } catch { fail('Invalid JSON request.'); } }
  if (!body || Array.isArray(body) || typeof body !== 'object' || JSON.stringify(body).length > 1900000) fail('Invalid request body.');
  return body;
}

function sessionContext(req, store) {
  const value = req.headers.cookie?.match(/(?:^|;\s*)form_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  const session = value && store.sessions.find(item => item.hash === digest(value) && item.expires > Date.now());
  const profile = session && store.profiles.find(item => item.id === session.user_id && item.enabled);
  const account = profile && store.accounts.find(item => item.profile_id === profile.id);
  return { profile, account };
}
function setSession(res, store, profile) {
  const value = token();
  store.sessions = store.sessions.filter(item => item.user_id !== profile.id && item.expires > Date.now());
  store.sessions.push({ hash: digest(value), user_id: profile.id, expires: Date.now() + 8 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', `form_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
}
function clearSession(req, res, store) {
  const value = req.headers.cookie?.match(/(?:^|;\s*)form_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (value) store.sessions = store.sessions.filter(item => item.hash !== digest(value));
  res.setHeader('Set-Cookie', 'form_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}
function requireAdmin(profile) { if (profile.role !== 'admin') fail('Administrator access is required.', 403); }
function uniqueEmail(store, email) { if (store.profiles.some(item => item.email === email)) fail('An account with this email already exists.', 409); }
function makeCycle(store, profile, planId, start) {
  const plan = store.plans.find(item => item.id === planId && item.available);
  if (!plan) fail('Select an available membership plan.');
  startDate(start);
  const end = addDays(start, plan.days - 1);
  if (store.memberships.some(item => item.member_id === profile.id && item.start_date <= end && item.end_date >= start)) fail('Membership dates overlap an existing cycle.', 409);
  const membership = { id: newId(), member_id: profile.id, plan_id: plan.id, start_date: start, end_date: end, created_at: now() };
  const invoice = { id: newId(), member_id: profile.id, membership_id: membership.id, amount_cents: plan.price_cents, paid_cents: 0, created_at: now() };
  store.memberships.push(membership);
  store.invoices.push(invoice);
  return { membership, invoice };
}
function makeProfile(store, body, role = 'member') {
  const info = contacts(body);
  uniqueEmail(store, info.email);
  const profile = { id: newId(), ...info, role, goal: validGoals.includes(body.goal) ? body.goal : 'Improve fitness', photo: '', enabled: true, created_at: now() };
  store.profiles.push(profile);
  return profile;
}
function memberView(profile, store) {
  const cycles = store.memberships.filter(item => item.member_id === profile.id).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const cycle = cycles.find(item => item.start_date <= today() && item.end_date >= today()) || cycles.find(item => item.start_date > today()) || cycles.at(-1);
  return {
    id: profile.id, name: profile.name, email: profile.email, phone: profile.phone, goal: profile.goal,
    enabled: profile.enabled, photo: profile.photo || '', photoPath: profile.photo || '', plan: cycle?.plan_id || 'basic',
    start: cycle?.start_date || today(), end: cycle?.end_date || today(), joined: profile.created_at.slice(0, 10)
  };
}
function stateFor(store, profile) {
  const isAdmin = profile.role === 'admin';
  const allowed = item => isAdmin || item.member_id === profile.id;
  const members = store.profiles.filter(item => item.role === 'member' && (isAdmin || item.id === profile.id)).map(item => memberView(item, store));
  const cycles = store.memberships.filter(allowed);
  const invoices = store.invoices.filter(allowed).map(item => {
    const cycle = store.memberships.find(value => value.id === item.membership_id);
    return { id: item.id, memberId: item.member_id, plan: cycle?.plan_id || 'basic', amount: item.amount_cents / 100, amountCents: item.amount_cents, paidCents: item.paid_cents, start: cycle?.start_date, end: cycle?.end_date, due: cycle?.start_date, created: item.created_at.slice(0, 10) };
  });
  const payments = store.payments.filter(allowed).map(viewPayment);
  const submissions = store.submissions.filter(allowed).map(item => ({ ...item }));
  const checkins = store.checkins.filter(allowed).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50).map(item => ({ id: item.id, memberId: item.member_id, name: store.profiles.find(value => value.id === item.member_id)?.name, date: item.created_at.slice(0, 10), timestamp: item.created_at }));
  const activity = [
    ...payments.map(item => ({ text: `Payment confirmed: PHP ${item.amount.toFixed(2)}.`, date: item.date })),
    ...checkins.map(item => ({ text: `${item.name || 'Member'} checked in.`, date: item.date }))
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  return {
    user: viewUser(profile), date: today(), members,
    plans: store.plans.map(viewPlan), invoices, memberships: cycles,
    payments, submissions, checkins, activity,
    settings: { payments: store.settings.payments || {}, email: isAdmin ? { connected: false, address: '', disabled: true } : null },
    outbox: isAdmin ? store.notifications.slice(-50).reverse().map(item => ({ ...item, created: Math.floor(Date.parse(item.created_at) / 1000), sent: null })) : []
  };
}
function notify(store, recipient, subject, body) {
  store.notifications.push({ id: newId(), recipient, subject, body, status: 'local', error: null, created_at: now() });
}
function saveImage(value) {
  if (!value) return '';
  imageData(value);
  return value;
}
function recordPayment(store, profile, body, submission) {
  const invoice = store.invoices.find(item => item.id === (submission?.invoice_id || body.invoiceId));
  if (!invoice) fail('Invoice not found.', 404);
  if (profile.role !== 'admin' && invoice.member_id !== profile.id) fail('Invoice not found.', 404);
  const amount = submission?.amount_cents ?? cents(body.amount);
  const method = submission?.method || body.method;
  const reference = String(submission?.reference ?? body.reference ?? '').trim();
  if (!['Cash', 'GCash', 'Bank transfer'].includes(method)) fail('Choose a valid payment method.');
  if (method !== 'Cash' && !/^[a-z0-9 -]{6,80}$/i.test(reference)) fail('Enter a valid transaction reference of 6–80 characters.');
  if (!submission && body.verified !== true) fail('Confirm receipt of the funds first.');
  if (amount > invoice.amount_cents - invoice.paid_cents) fail('Payment exceeds the remaining balance.', 409);
  const idempotencyKey = submission?.id || body.idempotencyKey || newId();
  const key = method === 'Cash' ? `CASH:${idempotencyKey}` : `${method}:${reference.replace(/[ -]/g, '').toUpperCase()}`;
  if (store.payments.some(item => item.reference_key === key)) fail('This payment was already recorded. Refresh and check the invoice.', 409);
  if (store.submissions.some(item => item.reference_key === key && item.id !== submission?.id)) fail('This reference belongs to a payment submission. Review that submission.', 409);
  const paymentDate = body.date || today();
  if (paymentDate < invoice.created_at.slice(0, 10) || paymentDate > today()) fail('Choose a payment date between invoice creation and today.');
  const payment = { id: newId(), invoice_id: invoice.id, member_id: invoice.member_id, amount_cents: amount, method, reference, reference_key: key, idempotency_key: idempotencyKey, payment_date: paymentDate, created_at: now() };
  store.payments.push(payment);
  invoice.paid_cents += amount;
  if (submission) submission.status = 'approved';
  const member = store.profiles.find(item => item.id === invoice.member_id);
  notify(store, member.email, 'FORM Fitness payment confirmed', `Payment of PHP ${(amount / 100).toFixed(2)} was recorded locally.`);
  return payment;
}
function qrSignature(store, payload) { return createHmac('sha256', store.qrSecret).update(payload).digest(); }
function verifyQR(store, value) {
  if (typeof value !== 'string' || value.length > 1000) fail('This is not a valid FORM member pass.');
  const [version, payload, signature, extra] = value.split('.');
  if (version !== 'FORMLOCAL1' || !payload || !signature || extra) fail('This QR code is not a valid FORM member pass.');
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { fail('This QR code is not a valid FORM member pass.'); }
  const expected = qrSignature(store, payload);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('This QR code is not a valid FORM member pass.');
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { fail('This QR code is not a valid FORM member pass.'); }
  const epoch = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(claims.exp) || claims.exp < epoch || claims.exp > epoch + 95) fail('This pass has expired. Ask the member to refresh their QR code.');
  if (store.checkins.some(item => item.nonce === claims.nonce)) fail('This pass was already used. Ask the member to refresh it.', 409);
  const member = store.profiles.find(item => item.id === claims.memberId && item.role === 'member' && item.enabled);
  if (!member) fail('Member not found.', 404);
  const cycle = store.memberships.find(item => item.member_id === member.id && item.start_date <= today() && item.end_date >= today());
  const invoice = cycle && store.invoices.find(item => item.membership_id === cycle.id);
  if (!invoice || invoice.paid_cents < invoice.amount_cents) fail('Check-in denied: this membership is not active.');
  return { member, claims, cycle };
}

export async function handle(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const origin = localOrigin(req);
    const url = new URL(req.url, origin);
    const path = url.pathname.replace(/^\/api/, '') || '/';
    if (!['GET', 'POST'].includes(req.method)) fail('Method not allowed.', 405);
    if (req.method === 'POST' && req.headers.origin !== origin) fail('Request origin is not allowed.', 403);
    const body = req.method === 'POST' ? await readBody(req) : {};
    const store = loadStore();
    const { profile, account } = sessionContext(req, store);
    const persist = () => saveStore(store);

    if (path === '/plans' && req.method === 'GET') return send(res, 200, { plans: store.plans.filter(item => item.available).map(viewPlan) });
    if (path === '/session' && req.method === 'GET') return send(res, 200, { user: profile ? viewUser(profile) : null, canOwnerLogin: false, canSetup: !store.profiles.some(item => item.role === 'admin'), date: today() });
    if (path === '/setup' && req.method === 'POST') {
      if (store.profiles.some(item => item.role === 'admin')) fail('Local administrator setup has already been completed.', 409);
      const info = contacts(body); password(body.password); uniqueEmail(store, info.email);
      const admin = { id: newId(), ...info, role: 'admin', goal: 'Improve fitness', photo: '', enabled: true, created_at: now() };
      const credentials = passwordHash(body.password);
      store.profiles.push(admin); store.accounts.push({ profile_id: admin.id, ...credentials }); setSession(res, store, admin); persist();
      return send(res, 201, { ok: true });
    }
    if (path === '/login' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      const found = store.profiles.find(item => item.email === email && item.enabled);
      const userAccount = found && store.accounts.find(item => item.profile_id === found.id);
      if (!passwordMatches(String(body.password || ''), userAccount)) fail('Email or password is incorrect.', 401);
      setSession(res, store, found); persist(); return send(res, 200, { ok: true, user: viewUser(found) });
    }
    if (path === '/logout' && req.method === 'POST') { clearSession(req, res, store); persist(); return send(res, 200, { ok: true }); }
    if (path === '/signup' && req.method === 'POST') {
      const info = contacts(body); password(body.password); const profile = makeProfile(store, { ...body, ...info });
      const credentials = passwordHash(body.password); store.accounts.push({ profile_id: profile.id, ...credentials });
      makeCycle(store, profile, body.plan, body.start || today()); setSession(res, store, profile); persist();
      return send(res, 201, { memberId: profile.id, requiresEmailConfirmation: false });
    }
    if (path === '/recovery' && req.method === 'POST') fail('Password recovery email is not available in local mode. Ask the local administrator to reset this account.', 400);
    if (!profile) fail('Please sign in to an authorized account for this workspace.', 401);
    if (path === '/state' && req.method === 'GET') return send(res, 200, stateFor(store, profile));
    if (path === '/qr' && req.method === 'GET') {
      if (profile.role !== 'member') fail('Member passes are available only to a member account.', 403);
      const cycle = store.memberships.find(item => item.member_id === profile.id && item.start_date <= today() && item.end_date >= today());
      const invoice = cycle && store.invoices.find(item => item.membership_id === cycle.id);
      if (!invoice || invoice.paid_cents < invoice.amount_cents) fail('An active, fully paid membership is required for a member pass.');
      const claims = { memberId: profile.id, exp: Math.floor(Date.now() / 1000) + 90, nonce: newId() };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return send(res, 200, { token: `FORMLOCAL1.${payload}.${qrSignature(store, payload).toString('base64url')}`, expires: claims.exp });
    }
    const adminOnly = ['/members', '/payments', '/review-payment', '/scan', '/check-in', '/settings/payments', '/settings/email', '/plans', '/manage-member', '/email-retry', '/reset-password'];
    if (adminOnly.includes(path)) requireAdmin(profile);
    if (path === '/login') return send(res, 200, { ok: true, user: viewUser(profile) });
    if (path === '/members' && req.method === 'POST') {
      const info = contacts(body); password(body.password); const member = makeProfile(store, { ...body, ...info });
      store.accounts.push({ profile_id: member.id, ...passwordHash(body.password) });
      const { invoice } = makeCycle(store, member, body.plan, body.start || today()); persist();
      return send(res, 201, { member: memberView(member, store), invoice });
    }
    if (path === '/profile' && req.method === 'POST') {
      if (profile.role !== 'member') fail('Sign in to the member account to edit its profile.', 403);
      const info = contacts(body); if (info.email !== profile.email) fail('Email changes require administrator assistance.');
      Object.assign(profile, info, { goal: validGoals.includes(body.goal) ? body.goal : profile.goal });
      if (body.photo !== undefined) profile.photo = saveImage(body.photo);
      persist(); return send(res, 200, { ok: true });
    }
    if (path === '/password' || path === '/set-password') {
      password(body.newPassword);
      if (path === '/password' && !passwordMatches(String(body.currentPassword || ''), account)) fail('Current password is incorrect.', 401);
      const credentials = passwordHash(body.newPassword); Object.assign(account, credentials);
      store.sessions = store.sessions.filter(item => item.user_id !== profile.id); setSession(res, store, profile); persist();
      return send(res, 200, { ok: true });
    }
    if (path === '/reset-password' && req.method === 'POST') {
      password(body.newPassword);
      const member = store.profiles.find(item => item.id === body.id && item.role === 'member');
      if (!member) fail('Member not found.', 404);
      const memberAccount = store.accounts.find(item => item.profile_id === member.id);
      if (!memberAccount) fail('Member account was not found.', 404);
      Object.assign(memberAccount, passwordHash(body.newPassword));
      store.sessions = store.sessions.filter(item => item.user_id !== member.id);
      persist(); return send(res, 200, { ok: true });
    }
    if (path === '/auth/verify' || path === '/auth/callback') fail('Invitation and email verification links are not used in local mode. Sign in with the account password.', 400);
    if (path === '/settings/email') fail('Email delivery is disabled in local-only mode. Notifications are saved in this computer’s local records.', 400);
    if (path === '/email-retry') return send(res, 200, { status: 'local', count: 0 });
    if (path === '/settings/payments' && req.method === 'POST') {
      const settings = {};
      for (const key of ['gcash', 'bank']) {
        if (!body[key]) continue;
        const item = body[key];
        if (typeof item.name !== 'string' || item.name.trim().length < 2 || item.name.length > 100 || /[<>\r\n]/.test(item.name) || typeof item.detail !== 'string' || item.detail.length > 120 || /[<>\r\n]/.test(item.detail)) fail('Enter valid payment recipient details.');
        settings[key] = { image: saveImage(item.image), imagePath: item.image, name: item.name.trim(), detail: item.detail.trim() };
      }
      store.settings.payments = settings; persist(); return send(res, 200, { ok: true });
    }
    if (path === '/manage-member' && req.method === 'POST') {
      const member = store.profiles.find(item => item.id === body.id && item.role === 'member');
      if (!member) fail('Member not found.', 404);
      member.enabled = body.enabled === true; if (!member.enabled) store.sessions = store.sessions.filter(item => item.user_id !== member.id);
      persist(); return send(res, 200, { ok: true });
    }
    if (path === '/plans' && req.method === 'POST') {
      const plan = store.plans.find(item => item.id === body.id); if (!plan) fail('Plan not found.', 404);
      if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.trim().length > 60 || /[<>\r\n]/.test(body.name)) fail('Enter a valid plan name.');
      plan.name = body.name.trim(); plan.price_cents = cents(body.price); plan.available = body.available === true;
      persist(); return send(res, 200, { ok: true });
    }
    if (path === '/renew' && req.method === 'POST') {
      const memberId = body.memberId || profile.id;
      if (profile.role !== 'admin' && memberId !== profile.id) fail('Member not found.', 403);
      const member = store.profiles.find(item => item.id === memberId && item.role === 'member' && item.enabled);
      if (!member) fail('Member not found.', 404);
      const result = makeCycle(store, member, body.plan, body.start); persist();
      return send(res, 200, { invoiceId: result.invoice.id });
    }
    if (path === '/payments' && req.method === 'POST') {
      const payment = recordPayment(store, profile, body); persist(); return send(res, 200, { payment: viewPayment(payment) });
    }
    if (path === '/payment-submissions' && req.method === 'POST') {
      if (profile.role !== 'member') fail('Sign in as the paying member.', 403);
      const invoice = store.invoices.find(item => item.id === body.invoiceId && item.member_id === profile.id);
      if (!invoice) fail('Invoice not found.', 404);
      const amount = cents(body.amount); if (amount > invoice.amount_cents - invoice.paid_cents) fail('Amount exceeds the remaining balance.');
      const method = body.method; if (!['GCash', 'Bank transfer'].includes(method)) fail('Choose GCash or bank transfer.');
      const key = method === 'GCash' ? 'gcash' : 'bank'; if (!store.settings.payments?.[key]?.image) fail('This payment method has not been set up by your gym.');
      const reference = String(body.reference || '').trim(); if (!/^[a-z0-9 -]{6,80}$/i.test(reference)) fail('Enter a valid transaction reference of 6–80 characters.');
      const referenceKey = `${method}:${reference.replace(/[ -]/g, '').toUpperCase()}`;
      if (store.submissions.some(item => item.reference_key === referenceKey) || store.payments.some(item => item.reference_key === referenceKey)) fail('That transaction reference has already been used.', 409);
      const submission = { id: newId(), invoice_id: invoice.id, member_id: profile.id, amount_cents: amount, amount: amount / 100, method, reference, reference_key: referenceKey, receipt: saveImage(body.receipt || ''), status: 'pending', created_at: now() };
      store.submissions.push(submission); notify(store, 'local administrator', 'FORM Fitness payment awaiting review', `${profile.name} submitted a ${method} payment for PHP ${(amount / 100).toFixed(2)}.`);
      persist(); return send(res, 201, { submission });
    }
    if (path === '/review-payment' && req.method === 'POST') {
      const submission = store.submissions.find(item => item.id === body.id && item.status === 'pending');
      if (!submission) fail('This payment was already reviewed or is unavailable.', 409);
      if (body.approve === true) {
        if (body.verified !== true) fail('Confirm receipt of the funds first.');
        recordPayment(store, profile, body, submission);
      }
      else { submission.status = 'rejected'; notify(store, store.profiles.find(item => item.id === submission.member_id).email, 'FORM Fitness payment needs attention', 'The submitted payment was rejected by the local administrator.'); }
      persist(); return send(res, 200, { ok: true });
    }
    if (path === '/scan' && req.method === 'POST') {
      const { member, cycle } = verifyQR(store, body.token);
      return send(res, 200, { member: { ...memberView(member, store), photo: member.photo || '', plan: cycle.plan_id } });
    }
    if (path === '/check-in' && req.method === 'POST') {
      if (body.confirmed !== true) fail('Match the member to their photo or photo ID first.');
      const { member, claims } = verifyQR(store, body.token);
      const checkin = { id: newId(), member_id: member.id, nonce: claims.nonce, created_at: now() };
      store.checkins.push(checkin); notify(store, member.email, 'FORM Fitness check-in confirmed', `A check-in was recorded locally for ${member.name}.`);
      persist(); return send(res, 201, { checkin: { id: checkin.id, memberId: member.id, name: member.name, date: today(), timestamp: checkin.created_at } });
    }
    fail('Endpoint not found.', 404);
  } catch (error) {
    if (error instanceof HttpError) return send(res, error.status, { error: error.message });
    console.error('FORM local API failure:', error.name);
    return send(res, 500, { error: 'The request could not be completed. Please try again.' });
  }
}
