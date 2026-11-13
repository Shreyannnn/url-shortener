import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 50,
  duration: '20s',
};

export function setup() {
  const res = http.post(
    'http://localhost:3000/shorten',
    JSON.stringify({ url: 'https://github.com' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  return { code: res.json('short_code') };
}

export default function (data) {
  const res = http.get(`http://localhost:3000/${data.code}`, { redirects: 0 });
  check(res, { 'status is 302': (r) => r.status === 302 });
}