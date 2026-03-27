const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL;

let poolConfig;

if (dbUrl) {
  console.log(`[pool] Using DATABASE_URL (length=${dbUrl.length}): ${dbUrl.substring(0, 40)}...`);
  
  // Railway native Postgres and most managed DBs need SSL
  // Only disable SSL if explicitly set to 'false'
  const sslDisabled = process.env.DATABASE_SSL === 'false';
  
  poolConfig = {
    connectionString: dbUrl,
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
  };
} else {
  console.error('[pool] FATAL: DATABASE_URL environment variable is required.');
  console.error('[pool] Set it in Railway dashboard or create a local .env file.');
  console.error('[pool] Example: DATABASE_URL=postgresql://user:pass@localhost:5432/pinuy_binuy');
  process.exit(1);
}

console.log('[pool] Pool config keys:', Object.keys(poolConfig).join(', '));
console.log('[pool] SSL:', poolConfig.ssl ? 'enabled' : 'disabled');

const pool = new Pool({
  ...poolConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err.message);
});

module.exports = pool;
