import http from 'k6/http';
import { check } from 'k6';

export const options = {
  vus: 50,
  duration: '20s',
};

export default function () {
  // 80% of traffic goes to 100 popular links, 20% to any of the 10,000
  const n = Math.random() < 0.8
    ? 1 + Math.floor(Math.random() * 100)
    : 1 + Math.floor(Math.random() * 10000);

  const res = http.get(`http://localhost:3000/seed${n}`, { redirects: 0 });
  check(res, { 'status is 302': (r) => r.status === 302 });
}