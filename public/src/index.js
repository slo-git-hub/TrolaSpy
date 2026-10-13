// Public "Where's Trola" page (no login). Everything it shows comes from shared/public.js,
// which only ever hands out a rough area; the private map stays behind Cloudflare Access.
import page from './page.html';
import logo from '../../web/src/logo.svg';
import banner from '../../web/src/banner.jpg';
import icon192 from '../../web/src/icon-192.png';
import { publicWhere, publicPhotoAllowed } from '../../shared/public.js';
import { servePhoto } from '../../web/src/photos.js';

const json = (data) => new Response(JSON.stringify(data), {
  headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/api/where') return json(await publicWhere(env.DB));
    const m = url.pathname.match(/^\/photos\/([0-9a-f-]{36})((?:_t)?\.jpg|\.mp4)$/);
    if (m) {
      if (!(await publicPhotoAllowed(env.DB, m[1]))) return new Response('Not found', { status: 404 });
      return servePhoto(env, `${m[1]}${m[2]}`, 'public, max-age=86400', request);
    }
    if (url.pathname === '/logo') return new Response(logo, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
    if (url.pathname === '/banner.jpg') return new Response(banner, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
    if (url.pathname === '/icon-192.png') return new Response(icon192, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
    if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /api/\n', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    }
    return new Response('Not found', { status: 404 });
  },
};
