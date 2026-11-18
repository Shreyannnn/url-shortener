CREATE TABLE IF NOT EXISTS urls (
  id SERIAL PRIMARY KEY,
  short_code VARCHAR(10) UNIQUE NOT NULL,
  original_url TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- seed data for load tests (delete these lines if you don't want it)
INSERT INTO urls (short_code, original_url)
SELECT 'seed' || g, 'https://example.com/page/' || g
FROM generate_series(1, 10000) AS g
ON CONFLICT (short_code) DO NOTHING;