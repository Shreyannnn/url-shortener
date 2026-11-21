require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('redis');
const pool = require('./db');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(express.json());

const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  disableOfflineQueue: true,
});
redis.on('error', (err) => console.error('Redis error:', err.message));
redis.connect().catch(() => console.error('Redis unavailable, running without cache'));

const stats = { hits: 0, misses: 0 };
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT_ENABLED !== 'false';

// Fixed-window rate limiter backed by Redis
function rateLimiter({ name, limit, windowSec }) {
  return async (req, res, next) => {
    if (!RATE_LIMIT_ENABLED) return next();
    const key = `rl:${name}:${req.ip}`;
    try {
      const [count] = await redis
        .multi()
        .incr(key)
        .expire(key, windowSec, 'NX')
        .exec();

      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(Math.max(0, limit - count)));

      if (count > limit) {
        const ttl = await redis.ttl(key);
        res.set('Retry-After', String(ttl > 0 ? ttl : windowSec));
        return res.status(429).json({ error: 'Too many requests, slow down' });
      }
    } catch {
      // Redis is down: fail open (let the request through)
    }
    next();
  };
}

const shortenLimiter = rateLimiter({ name: 'shorten', limit: 10, windowSec: 60 });
const redirectLimiter = rateLimiter({ name: 'redirect', limit: 300, windowSec: 60 });

function generateCode() {
  return crypto.randomBytes(5).toString('base64url').slice(0, 7);
}

function isValidUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

app.get('/', (req, res) => {
  res.send('URL shortener is running');
});

// Cache hit/miss counters
app.get('/stats', (req, res) => {
  const total = stats.hits + stats.misses;
  res.json({
    ...stats,
    hit_rate: total ? +(stats.hits / total).toFixed(4) : 0,
  });
});

// Browsers ask for this automatically; answer without touching the database
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Create a short link
app.post('/shorten', shortenLimiter, async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'Provide a valid http/https url' });
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await pool.query(
        'INSERT INTO urls (short_code, original_url) VALUES ($1, $2)',
        [code, url]
      );
      return res.status(201).json({
        short_code: code,
        short_url: `${BASE_URL}/${code}`,
      });
    } catch (err) {
      if (err.code === '23505') continue; // code already exists, try another
      console.error(err);
      return res.status(500).json({ error: 'Server error' });
    }
  }
  res.status(500).json({ error: 'Could not generate a unique code' });
});

// Redirect a short link (cache-aside with Redis)
app.get('/:code', redirectLimiter, async (req, res) => {
  const { code } = req.params;
  const key = `url:${code}`;
  try {
    let url = null;
    try {
      url = CACHE_ENABLED ? await redis.get(key) : null;
    } catch {
      // cache is down: fall through to the database
    }

    if (url) {
      stats.hits++;
      return res.redirect(url);
    }

    stats.misses++;
    const result = await pool.query(
      'SELECT original_url FROM urls WHERE short_code = $1',
      [code]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Short link not found' });
    }

    url = result.rows[0].original_url;
    try {
      if (CACHE_ENABLED) await redis.set(key, url, { EX: 3600 });
    } catch {
      // ignore cache write failures
    }
    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create the table on start-up if it doesn't exist (cloud databases start empty)
pool
  .query(
    `CREATE TABLE IF NOT EXISTS urls (
       id SERIAL PRIMARY KEY,
       short_code VARCHAR(10) UNIQUE NOT NULL,
       original_url TEXT NOT NULL,
       created_at TIMESTAMP DEFAULT NOW()
     )`
  )
  .catch((err) => console.error('Table setup failed:', err.message));

app.listen(PORT, () => {
  console.log(`Server on ${BASE_URL}`);
});