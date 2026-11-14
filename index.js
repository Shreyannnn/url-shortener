require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('redis');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const redis = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  disableOfflineQueue: true,
});
redis.on('error', (err) => console.error('Redis error:', err.message));
redis.connect().catch(() => console.error('Redis unavailable, running without cache'));

const stats = { hits: 0, misses: 0 };
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';

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

// Create a short link
app.post('/shorten', async (req, res) => {
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
        short_url: `http://localhost:${PORT}/${code}`,
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
app.get('/:code', async (req, res) => {
  const { code } = req.params;
  const key = `url:${code}`;
  try {
    let url = null;
    try {
      // url = await redis.get(key);
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
      // await redis.set(key, url, { EX: 3600 });
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

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});