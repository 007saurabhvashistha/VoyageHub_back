import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { generate } from 'otplib';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { EmbeddedPostgresPool } from '../src/db/embeddedPool.js';
import { decryptEmailActionToken } from '../src/utils/emailActionTokens.js';

const migrationNames = (await readdir(fileURLToPath(new URL('../db/migrations/', import.meta.url)))).filter((name) => name.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationNames.map(async (name) => {
  const migrationUrl = new URL(`../db/migrations/${name}`, import.meta.url);
  return readFile(fileURLToPath(migrationUrl), 'utf8');
}));
const tokenEncryptionKey = Buffer.alloc(32, 17);
const mfaEncryptionKey = Buffer.alloc(32, 23);

async function startIdentityApp(context, { emailVerificationRequired = true, testTokenKey = tokenEncryptionKey } = {}) {
  const database = new PGlite();
  await database.waitReady;
  const pool = new EmbeddedPostgresPool(database);
  for (const migration of migrations) await pool.exec(migration);
  const server = createApp({ pool, secureCookies: false, emailDelivery: async () => {}, tokenEncryptionKey: testTokenKey, mfaEncryptionKey, emailVerificationRequired }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  });
  return { pool, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function verifyEmail(baseUrl, pool, userId) {
  const stored = await pool.query(
    "SELECT token_ciphertext FROM auth_email_tokens WHERE user_id = $1 AND purpose = 'verify_email' AND used_at IS NULL ORDER BY created_at DESC LIMIT 1",
    [userId],
  );
  const token = decryptEmailActionToken(stored.rows[0].token_ciphertext, tokenEncryptionKey);
  return fetch(`${baseUrl}/v1/auth/verify-email/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function registerAndVerify(baseUrl, pool, body = registration) {
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal((await verifyEmail(baseUrl, pool, result.user.id)).status, 200);
  return result;
}

const registration = {
  full_name: 'Maya Chen',
  organization_name: 'Northstar Travel',
  email: 'MAYA@EXAMPLE.TEST',
  country_code: 'IN',
  business_type: 'agency',
  password: 'correct-horse-2026',
};

test('email verification is required by default and can be disabled by configuration', () => {
  assert.equal(loadConfig({}).emailVerificationRequired, true);
  assert.equal(loadConfig({ EMAIL_VERIFICATION_REQUIRED: 'false' }).emailVerificationRequired, false);
});

test('registration persists an unverified account without issuing a session, then verification allows login', async (context) => {
  const { pool, baseUrl } = await startIdentityApp(context);
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registration),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.user.email, 'maya@example.test');
  assert.equal(body.organization.businessType, 'agency');
  assert.equal(body.verificationRequired, true);
  assert.equal(body.emailDeliveryStatus, 'queued');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM organization_memberships WHERE access_role = $1', ['owner'])).rows[0].count, 1);
  assert.equal((await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [body.user.id])).rows[0].email_verified_at, null);
  const verificationOutbox = await pool.query("SELECT allow_unverified FROM notification_outbox WHERE recipient_user_id = $1 AND event_type = 'email_verification'", [body.user.id]);
  assert.equal(verificationOutbox.rows[0].allow_unverified, true);

  const blockedLogin = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registration.email, password: registration.password, business_type: 'agency' }),
  });
  assert.equal(blockedLogin.status, 403);
  assert.equal((await blockedLogin.json()).error.code, 'EMAIL_NOT_VERIFIED');
  assert.equal((await verifyEmail(baseUrl, pool, body.user.id)).status, 200);

  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registration.email, password: registration.password, business_type: 'agency' }),
  });
  assert.equal(login.status, 200);
  assert.ok((await login.json()).csrfToken);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i);

  const cookie = login.headers.get('set-cookie').split(';')[0];
  const profile = await fetch(`${baseUrl}/v1/auth/me`, { headers: { cookie } });
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).organization.accessRole, 'owner');
});

test('registration rejects duplicate email and invalid business roles', async (context) => {
  const { baseUrl } = await startIdentityApp(context);
  const post = (body) => fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal((await post(registration)).status, 201);
  const duplicate = await post({ ...registration, organization_name: 'Another Agency' });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'EMAIL_IN_USE');
  const invalidRole = await post({ ...registration, email: 'new@example.test', business_type: 'superadmin' });
  assert.equal(invalidRole.status, 400);
});

test('login checks the selected business type and logout requires CSRF protection', async (context) => {
  const { pool, baseUrl } = await startIdentityApp(context);
  await registerAndVerify(baseUrl, pool);

  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'maya@example.test', password: registration.password, business_type: 'agency' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const csrfToken = (await login.json()).csrfToken;
  const rejectedLogout = await fetch(`${baseUrl}/v1/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(rejectedLogout.status, 403);
  const logout = await fetch(`${baseUrl}/v1/auth/logout`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken } });
  assert.equal(logout.status, 204);
  const profile = await fetch(`${baseUrl}/v1/auth/me`, { headers: { cookie } });
  assert.equal(profile.status, 401);
});

test('session inventory is private and sign out everywhere revokes all of the user sessions', async (context) => {
  const { pool, baseUrl } = await startIdentityApp(context);
  await registerAndVerify(baseUrl, pool);
  const login = async (email = registration.email) => {
    const response = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: registration.password, business_type: 'agency' }),
    });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], ...(await response.json()) };
  };
  const current = await login();
  const other = await login();
  const currentCookie = { cookie: current.cookie };
  const list = await fetch(`${baseUrl}/v1/auth/sessions`, { headers: { cookie: current.cookie } });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'private, no-store');
  const { sessions } = await list.json();
  assert.equal(sessions.length, 2);
  const currentSession = sessions.find((session) => session.current);
  const otherSession = sessions.find((session) => !session.current);
  assert.ok(currentSession);
  assert.ok(otherSession);
  assert.equal(otherSession.organizationName, 'Northstar Travel');

  await registerAndVerify(baseUrl, pool, { ...registration, full_name: 'Other User', organization_name: 'Other Agency', email: 'other@example.test' });
  const foreign = await login('other@example.test');
  const foreignSessions = await (await fetch(`${baseUrl}/v1/auth/sessions`, { headers: { cookie: foreign.cookie } })).json();
  const crossUserRevoke = await fetch(`${baseUrl}/v1/auth/sessions/${foreignSessions.sessions[0].id}`, {
    method: 'DELETE',
    headers: { cookie: current.cookie, 'x-csrf-token': current.csrfToken },
  });
  assert.equal(crossUserRevoke.status, 404);

  const revokeWithoutCsrf = await fetch(`${baseUrl}/v1/auth/sessions/${otherSession.id}`, { method: 'DELETE', headers: { cookie: current.cookie } });
  assert.equal(revokeWithoutCsrf.status, 403);
  const revokeOther = await fetch(`${baseUrl}/v1/auth/sessions/${otherSession.id}`, { method: 'DELETE', headers: { cookie: current.cookie, 'x-csrf-token': current.csrfToken } });
  assert.equal(revokeOther.status, 204);
  assert.equal((await fetch(`${baseUrl}/v1/auth/me`, { headers: { cookie: other.cookie } })).status, 401);
  assert.equal((await (await fetch(`${baseUrl}/v1/auth/sessions`, { headers: { cookie: current.cookie } })).json()).sessions.length, 1);

  const signOutWithoutCsrf = await fetch(`${baseUrl}/v1/auth/sessions/sign-out-everywhere`, { method: 'POST', headers: { cookie: current.cookie } });
  assert.equal(signOutWithoutCsrf.status, 403);
  const signOutEverywhere = await fetch(`${baseUrl}/v1/auth/sessions/sign-out-everywhere`, {
    method: 'POST',
    headers: { cookie: current.cookie, 'x-csrf-token': current.csrfToken },
  });
  assert.equal(signOutEverywhere.status, 200);
  assert.equal((await signOutEverywhere.json()).revokedSessions, 1);
  assert.match(signOutEverywhere.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/i);
  assert.equal((await fetch(`${baseUrl}/v1/auth/me`, { headers: { cookie: current.cookie } })).status, 401);
});

test('login does not authenticate an account under a different business type', async (context) => {
  const { pool, baseUrl } = await startIdentityApp(context);
  await registerAndVerify(baseUrl, pool);
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registration.email, password: registration.password, business_type: 'hotelier' }),
  });
  assert.equal(login.status, 401);
});

test('verification resend is enumeration-safe and tokens are single-use', async (context) => {
  const { pool, baseUrl } = await startIdentityApp(context);
  const registrationResponse = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(registration),
  });
  const account = await registrationResponse.json();
  const initialTokenRow = await pool.query("SELECT token_ciphertext FROM auth_email_tokens WHERE user_id = $1 AND purpose = 'verify_email' AND used_at IS NULL", [account.user.id]);
  const initialToken = decryptEmailActionToken(initialTokenRow.rows[0].token_ciphertext, tokenEncryptionKey);
  const existing = await fetch(`${baseUrl}/v1/auth/verify-email/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: registration.email }),
  });
  const unknown = await fetch(`${baseUrl}/v1/auth/verify-email/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'missing@example.test' }),
  });
  assert.equal(existing.status, 202);
  assert.deepEqual(await existing.json(), await unknown.json());
  const invalidatedToken = await fetch(`${baseUrl}/v1/auth/verify-email/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: initialToken }),
  });
  assert.equal(invalidatedToken.status, 400);
  const latestTokenRow = await pool.query("SELECT token_ciphertext FROM auth_email_tokens WHERE user_id = $1 AND purpose = 'verify_email' AND used_at IS NULL", [account.user.id]);
  const latestToken = decryptEmailActionToken(latestTokenRow.rows[0].token_ciphertext, tokenEncryptionKey);
  const confirmed = await fetch(`${baseUrl}/v1/auth/verify-email/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: latestToken }),
  });
  assert.equal(confirmed.status, 200);
  const reusedToken = await fetch(`${baseUrl}/v1/auth/verify-email/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: latestToken }),
  });
  assert.equal(reusedToken.status, 400);
});

test('password recovery is enumeration-safe, single-use and revokes every existing session', async (context) => {
  const { pool, baseUrl } = await startIdentityApp(context);
  const account = await registerAndVerify(baseUrl, pool);
  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registration.email, password: registration.password, business_type: 'agency' }),
  });
  const oldCookie = login.headers.get('set-cookie').split(';')[0];
  const existing = await fetch(`${baseUrl}/v1/auth/password-reset/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: registration.email }),
  });
  const unknown = await fetch(`${baseUrl}/v1/auth/password-reset/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'missing@example.test' }),
  });
  assert.equal(existing.status, 202);
  assert.deepEqual(await existing.json(), await unknown.json());

  const stored = await pool.query("SELECT token_ciphertext FROM auth_email_tokens WHERE user_id = $1 AND purpose = 'password_reset' AND used_at IS NULL", [account.user.id]);
  const token = decryptEmailActionToken(stored.rows[0].token_ciphertext, tokenEncryptionKey);
  const reset = await fetch(`${baseUrl}/v1/auth/password-reset/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password: 'a-new-correct-password' }),
  });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).sessionsRevoked, true);
  assert.equal((await fetch(`${baseUrl}/v1/auth/me`, { headers: { cookie: oldCookie } })).status, 401);
  const oldPassword = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registration.email, password: registration.password, business_type: 'agency' }),
  });
  assert.equal(oldPassword.status, 401);
  const newPassword = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registration.email, password: 'a-new-correct-password', business_type: 'agency' }),
  });
  assert.equal(newPassword.status, 200);
  const replay = await fetch(`${baseUrl}/v1/auth/password-reset/complete`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password: 'another-correct-password' }),
  });
  assert.equal(replay.status, 400);
});

test('platform admins must enroll MFA; TOTP challenges reject replay and recovery codes are single-use', async (context) => {
  const { pool, baseUrl } = await startIdentityApp(context);
  const account = await registerAndVerify(baseUrl, pool);
  await pool.query('UPDATE users SET is_platform_admin = TRUE WHERE id = $1', [account.user.id]);

  const setupLogin = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registration.email, password: registration.password, business_type: 'agency' }),
  });
  const setupPayload = await setupLogin.json();
  assert.equal(setupPayload.mfaSetupRequired, true);
  const setupCookie = setupLogin.headers.get('set-cookie').split(';')[0];
  const blockedAdminApi = await fetch(`${baseUrl}/v1/admin/seller-profiles/pending`, { headers: { cookie: setupCookie } });
  assert.equal(blockedAdminApi.status, 403);
  assert.equal((await blockedAdminApi.json()).error.code, 'MFA_REQUIRED');

  const enrollment = await fetch(`${baseUrl}/v1/auth/mfa/enrollment/start`, {
    method: 'POST',
    headers: { cookie: setupCookie, 'content-type': 'application/json', 'x-csrf-token': setupPayload.csrfToken },
    body: '{}',
  });
  assert.equal(enrollment.status, 201);
  const enrollmentBody = await enrollment.json();
  assert.match(enrollmentBody.otpauthUri, /^otpauth:\/\/totp\//);
  const enrollmentCode = await generate({ secret: enrollmentBody.secret });
  const confirmed = await fetch(`${baseUrl}/v1/auth/mfa/enrollment/confirm`, {
    method: 'POST',
    headers: { cookie: setupCookie, 'content-type': 'application/json', 'x-csrf-token': setupPayload.csrfToken },
    body: JSON.stringify({ code: enrollmentCode }),
  });
  assert.equal(confirmed.status, 200);
  const recoveryCodes = (await confirmed.json()).recoveryCodes;
  assert.equal(recoveryCodes.length, 10);

  await pool.query("UPDATE user_mfa SET last_totp_accepted_at = NOW() - INTERVAL '2 minutes' WHERE user_id = $1", [account.user.id]);
  const challengeLogin = async () => {
    const response = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: registration.email, password: registration.password, business_type: 'agency' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mfaRequired, true);
    const challenge = { cookie: response.headers.get('set-cookie').split(';')[0], csrfToken: body.csrfToken };
    const refreshedCsrf = await fetch(`${baseUrl}/v1/auth/mfa/challenge/csrf`, { headers: { cookie: challenge.cookie } });
    assert.equal(refreshedCsrf.status, 200);
    challenge.csrfToken = (await refreshedCsrf.json()).csrfToken;
    return challenge;
  };
  const completeChallenge = async (challenge, code) => fetch(`${baseUrl}/v1/auth/mfa/challenge`, {
    method: 'POST',
    headers: { cookie: challenge.cookie, 'content-type': 'application/json', 'x-csrf-token': challenge.csrfToken },
    body: JSON.stringify({ code }),
  });

  const firstChallenge = await challengeLogin();
  const acceptedTotp = await generate({ secret: enrollmentBody.secret });
  const firstProof = await completeChallenge(firstChallenge, acceptedTotp);
  assert.equal(firstProof.status, 200);
  const firstProofCookies = firstProof.headers.get('set-cookie').split(', ');
  const authenticatedCookie = firstProofCookies.find((cookie) => cookie.startsWith('lead_exchange_session='));
  assert.ok(authenticatedCookie);
  const allowedAdminApi = await fetch(`${baseUrl}/v1/admin/seller-profiles/pending`, { headers: { cookie: authenticatedCookie.split(';')[0] } });
  assert.equal(allowedAdminApi.status, 200);

  const replayChallenge = await challengeLogin();
  const replay = await completeChallenge(replayChallenge, acceptedTotp);
  assert.equal(replay.status, 401);
  const recoveryLogin = await completeChallenge(replayChallenge, recoveryCodes[0]);
  assert.equal(recoveryLogin.status, 200);
  const recoveryLoginBody = await recoveryLogin.json();
  const recoveredSessionCookie = recoveryLogin.headers.get('set-cookie').split(';')[0];
  const rotatedCodesResponse = await fetch(`${baseUrl}/v1/auth/mfa/recovery-codes/rotate`, {
    method: 'POST',
    headers: { cookie: recoveredSessionCookie, 'content-type': 'application/json', 'x-csrf-token': recoveryLoginBody.csrfToken },
    body: JSON.stringify({ code: recoveryCodes[1] }),
  });
  assert.equal(rotatedCodesResponse.status, 200);
  const rotatedCodes = (await rotatedCodesResponse.json()).recoveryCodes;
  assert.equal(rotatedCodes.length, 10);
  const adminDisable = await fetch(`${baseUrl}/v1/auth/mfa/disable`, {
    method: 'POST',
    headers: { cookie: recoveredSessionCookie, 'content-type': 'application/json', 'x-csrf-token': recoveryLoginBody.csrfToken },
    body: JSON.stringify({ code: await generate({ secret: enrollmentBody.secret }) }),
  });
  assert.equal(adminDisable.status, 403);
  assert.equal((await adminDisable.json()).error.code, 'ADMIN_MFA_REQUIRED');

  const reusedRecoveryChallenge = await challengeLogin();
  const reusedRecovery = await completeChallenge(reusedRecoveryChallenge, recoveryCodes[0]);
  assert.equal(reusedRecovery.status, 401);
  const replacementRecovery = await completeChallenge(reusedRecoveryChallenge, rotatedCodes[0]);
  assert.equal(replacementRecovery.status, 200);
});

test('registration can skip email verification when explicitly disabled', async (context) => {
  const { pool, baseUrl } = await startIdentityApp(context, { emailVerificationRequired: false, testTokenKey: null });
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(registration),
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.verificationRequired, false);
  assert.equal(body.emailDeliveryStatus, 'not_required');
  assert.ok((await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [body.user.id])).rows[0].email_verified_at);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM notification_outbox WHERE recipient_user_id = $1 AND event_type = 'email_verification'", [body.user.id])).rows[0].count, 0);

  const login = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: registration.email, password: registration.password, business_type: 'agency' }),
  });
  assert.equal(login.status, 200);
});