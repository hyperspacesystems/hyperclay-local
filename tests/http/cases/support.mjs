import crypto from 'node:crypto';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function htmlDocument(marker, attributes = '') {
  const root = attributes ? `<html ${attributes}>` : '<html>';
  return `<!doctype html>\n${root}\n<head><meta charset="utf-8"><title>${marker}</title></head>\n<body><p>${marker}</p></body>\n</html>\n`;
}

export function documentEtag(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

export function documentUrl(ctx, rootId, docPath) {
  return `${ctx.rootUrl(rootId)}/${docPath}`;
}

export function saveHeaders(ctx, rootId, docPath, extra = {}) {
  return {
    'document-url': documentUrl(ctx, rootId, docPath),
    'content-type': 'text/plain; charset=utf-8',
    ...extra,
  };
}

export async function saveDocument(ctx, rootId, docPath, body, extra = {}) {
  return ctx.http(rootId, 'POST', '/_/save', {
    headers: saveHeaders(ctx, rootId, docPath, extra),
    body,
  });
}

export function bodyJson(response, label) {
  try {
    return response.json();
  } catch (error) {
    throw new Error(`${label}: body is not JSON (${error.message}): ${String(response.text).slice(0, 200)}`);
  }
}

export function assertEntityTagHeader(response, label) {
  const tag = response.header('etag');
  const shape = /^W\/"[0-9a-f]+-[A-Za-z0-9+/]{27}"$/;
  assert(
    typeof tag === 'string' && shape.test(tag),
    `${label}: ETag response header ${JSON.stringify(tag)} is not this host's weak entity tag over the response body`,
  );
}

export function assertCookieSet(response, name, label) {
  const found = response.setCookie.some((value) => value.startsWith(`${name}=`));
  assert(found, `${label}: ${name} cookie missing from ${JSON.stringify(response.setCookie)}`);
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
