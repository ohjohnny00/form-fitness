import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { today } from '../src/validation.js';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'form-fitness-local-'));
process.env.FORM_DATA_DIR = dataDir;
const { handle } = await import('../src/local-api.js');

test('local workspace setup, membership payment, session and QR check-in', async () => {
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { body, cookie } = {}) => {
    const response = await fetch(origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0]
    };
  };

  try {
    const initial = await request('/api/session');
    assert.equal(initial.data.canSetup, true);
    assert.equal((await request('/api/plans')).data.plans.length, 3);

    const setup = await request('/api/setup', { body: {
      name: 'Local Administrator', email: 'admin@example.test', phone: '09171234567', password: 'StrongPassword2026!'
    } });
    assert.equal(setup.status, 201);
    const adminCookie = setup.cookie;
    assert(adminCookie?.startsWith('form_session='));
    assert.equal((await request('/api/session', { cookie: adminCookie })).data.user.role, 'admin');

    const created = await request('/api/members', { cookie: adminCookie, body: {
      name: 'Local Member', email: 'member@example.test', phone: '09171234568', password: 'MemberPassword2026!', plan: 'basic', start: today()
    } });
    assert.equal(created.status, 201);
    const invoiceId = created.data.invoice.id;

    const payment = await request('/api/payments', { cookie: adminCookie, body: {
      invoiceId, amount: 899, method: 'Cash', verified: true, idempotencyKey: randomUUID(), date: today()
    } });
    assert.equal(payment.status, 200);
    assert.equal(payment.data.payment.amount, 899);

    const login = await request('/api/login', { body: { email: 'member@example.test', password: 'MemberPassword2026!' } });
    assert.equal(login.status, 200);
    const memberCookie = login.cookie;
    assert.equal((await request('/api/state', { cookie: memberCookie })).data.invoices[0].paidCents, 89900);

    const pass = await request('/api/qr', { cookie: memberCookie });
    assert.equal(pass.status, 200);
    const scan = await request('/api/scan', { cookie: adminCookie, body: { token: pass.data.token } });
    assert.equal(scan.status, 200);
    assert.equal(scan.data.member.email, 'member@example.test');
    const checkin = await request('/api/check-in', { cookie: adminCookie, body: { token: pass.data.token, confirmed: true } });
    assert.equal(checkin.status, 201);
    assert.equal((await request('/api/check-in', { cookie: adminCookie, body: { token: pass.data.token, confirmed: true } })).status, 409);
    const reset = await request('/api/reset-password', { cookie: adminCookie, body: { id: created.data.member.id, newPassword: 'ResetPassword2026!' } });
    assert.equal(reset.status, 200);
    assert.equal((await request('/api/login', { body: { email: 'member@example.test', password: 'MemberPassword2026!' } })).status, 401);
    assert.equal((await request('/api/login', { body: { email: 'member@example.test', password: 'ResetPassword2026!' } })).status, 200);
    assert.equal((await request('/api/session')).data.canSetup, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
