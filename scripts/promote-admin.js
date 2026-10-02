import 'dotenv/config';
import { createDatabase } from '../src/db/connect.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run admin:promote -- verified-owner@example.com');
  process.exitCode = 1;
} else {
  const { pool, close } = await createDatabase();
  try {
    const result = await pool.query('UPDATE users SET is_platform_admin = TRUE WHERE email = $1 RETURNING id', [email]);
    if (!result.rowCount) {
      console.error('No account found for that email. Register the account first, then promote it.');
      process.exitCode = 1;
    } else {
      console.log('Platform admin access granted. Sign out and sign back in to refresh the session.');
    }
  } catch {
    console.error('Admin promotion failed. Verify database access.');
    process.exitCode = 1;
  } finally {
    await close();
  }
}