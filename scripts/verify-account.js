import 'dotenv/config';
import { createDatabase } from '../src/db/connect.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run account:verify -- owner@example.com');
  process.exitCode = 1;
} else {
  const { pool, close } = await createDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()) WHERE email = $1 RETURNING id',
      [email],
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      console.error('No account found for that email. Register the account first.');
      process.exitCode = 1;
    } else {
      await client.query(
        "UPDATE auth_email_tokens SET used_at = NOW() WHERE user_id = $1 AND purpose = 'verify_email' AND used_at IS NULL",
        [result.rows[0].id],
      );
      await client.query('COMMIT');
      console.log('Email marked as verified by the operator. The account can now sign in.');
    }
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Account verification failed. Verify database access.');
    process.exitCode = 1;
  } finally {
    client.release();
    await close();
  }
}
