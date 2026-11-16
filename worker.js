/**
 * 살까말까 — 무료 미니 서버 (Cloudflare Workers)
 * =====================================================
 * 이 파일 하나만 Cloudflare 대시보드의 Workers 웹 에디터에 그대로 붙여넣고
 * [배포]를 누르면 바로 주소(https://이름.계정.workers.dev)가 생깁니다.
 * 외부 라이브러리(npm) 없이 브라우저 표준 fetch와 정규식만 씁니다.
 *
 * 쓰는 곳 (GET)
 *   1) 실시간 시세
 *      /?action=price&q=노부영
 *      → 당근마켓 검색 결과 HTML에서 제목·가격·링크를 읽어
 *        평균가·중앙값·최저가·최고가·샘플 매물(최대 10개)을 돌려줍니다.
 *
 *   2) 알바 공고 읽기
 *      /?action=job&url=https://jobs.daangn.com/job-posts/...
 *      → 당근알바·알바몬·알바천국 공고에서 제목·급여·근무시간·주소·본문을
 *        뽑아 한 덩어리 글로 돌려줍니다. (앱이 이 글로 위험도를 판독)
 *
 *   3) 연결 확인
 *      /?action=ping  → { ok:true, name:'살까말까', version:... }
 *
 * 안전장치
 *   - 알바 링크는 daangn.com / jobs.daangn.com / albamon.com / alba.co.kr
 *     및 그 서브도메인만 읽습니다(SSRF 방지, 리다이렉트도 매 단계 검사).
 *   - 응답 크기·시간을 제한하고, 실패하면 이유를 JSON으로 돌려줍니다.
 *   - 모든 응답에 CORS 허용 헤더를 붙여 GitHub Pages 앱에서 부를 수 있습니다.
 */

const VERSION = '3.0.0';
const APP_NAME = '살까말까';

/* 알바 공고로 읽어도 되는 도메인 (서브도메인 포함) */
const JOB_HOSTS = ['daangn.com', 'albamon.com', 'alba.co.kr'];

/* 시세 검색은 당근마켓만 사용 */
const PRICE_HOSTS = ['daangn.com'];

const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 ' +
  'Mobile/15E148 Safari/604.1';

const FETCH_TIMEOUT_MS = 15000;
const PRICE_MAX_BYTES = 3000000;
const JOB_MAX_BYTES = 2500000;

/* 같은 검색을 짧은 시간에 반복할 때 당근에 다시 묻지 않도록 메모리에 잠깐 담아 둡니다.
   (Workers 인스턴스가 살아 있는 동안만 유지되는 가벼운 캐시입니다.) */
const CACHE_TTL_PRICE = 5 * 60 * 1000;
const CACHE_TTL_JOB = 10 * 60 * 1000;
const cache = new Map();

/* ==================== 공통 ==================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status) {
  const headers = Object.assign(
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Salkka-Server': 'salkka-malkka/' + VERSION,
    },
    CORS
  );
  return new Response(JSON.stringify(data, null, 0), {
    status: status || 200,
    headers: headers,
  });
}

function fail(error, message, status, extra) {
  const body = Object.assign(
    { ok: false, error: error, message: message },
    extra || {}
  );
  return json(body, status || 400);
}

class HttpError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 502;
  }
}

function hostAllowed(hostname, list) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (host === d || host.slice(-(d.length + 1)) === '.' + d) return true;
  }
  return false;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl) {
  if (cache.size > 60) cache.clear();
  cache.set(key, { value: value, at: Date.now(), ttl: ttl });
}

/**
 * 화이트리스트 안의 주소만, 리다이렉트도 직접 따라가며 안전하게 가져옵니다.
 * (fetch의 자동 리다이렉트를 쓰면 화이트리스트 밖으로 튈 수 있어서 직접 따라갑니다.)
 */
async function safeFetch(target, allowedHosts) {
  let current = String(target);
  let lastStatus = 0;

  for (let hop = 0; hop < 5; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch (e) {
      throw new HttpError('bad_url', '주소 형식이 올바르지 않아요.', 400);
    }
    if (u.protocol !== 'https:') {
      throw new HttpError('bad_protocol', 'https 주소만 읽을 수 있어요.', 400);
    }
    if (u.username || u.password) {
      throw new HttpError('bad_url', '주소에 아이디·비밀번호를 넣을 수 없어요.', 400);
    }
    if (u.port && u.port !== '443') {
      throw new HttpError('bad_port', '일반 https 포트(443)만 쓸 수 있어요.', 400);
    }
    if (!hostAllowed(u.hostname, allowedHosts)) {
      throw new HttpError(
        'domain_not_allowed',
        '읽을 수 없는 주소예요. 당근(daangn.com)·당근알바(jobs.daangn.com)·알바몬(albamon.com)·알바천국(alba.co.kr) 링크만 넣어 주세요.',
        400
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(u.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': UA,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.6',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        throw new HttpError(
          'timeout',
          '사이트가 ' + Math.round(FETCH_TIMEOUT_MS / 1000) + '초 안에 응답하지 않았어요. 잠시 뒤 다시 해 주세요.',
          504
        );
      }
      throw new HttpError(
        'fetch_failed',
        '사이트에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.',
        502
      );
    }
    clearTimeout(timer);

    lastStatus = res.status;

    if ([301, 302, 303, 307, 308].indexOf(res.status) >= 0) {
      const loc = res.headers.get('location');
      if (!loc) {
        throw new HttpError('bad_redirect', '사이트가 이상한 주소로 넘겼어요.', 502);
      }
      current = new URL(loc, u).toString();
      continue;
    }

    return { res: res, finalUrl: u.toString(), status: res.status };
  }

  throw new HttpError(
    'too_many_redirects',
    '주소가 너무 여러 번 넘어가서 읽지 못했어요. (마지막 응답 ' + lastStatus + ')',
    502
  );
}

async function readBody(res, maxBytes) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) {
    throw new HttpError('too_large', '페이지가 너무 커서 읽지 못했어요.', 502);
  }
  let text = '';
  try {
    text = await res.text();
  } catch (e) {
    throw new HttpError('read_failed', '페이지 내용을 읽지 못했어요.', 502);
  }
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

/* ==================== HTML 파싱 도우미 ==================== */

function fromCode(code) {
  try {
    if (!isFinite(code) || code < 0 || code > 0x10ffff) return '';
    return String.fromCodePoint(code);
  } catch (e) {
    return '';
  }
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) {
      return fromCode(parseInt(h, 16));
    })
    .replace(/&#(\d+);/g, function (m, d) {
      return fromCode(parseInt(d, 10));
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&');
}

/** HTML 조각을 읽기 좋은 글덩어리로 바꿉니다. */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(
    /<(script|style|noscript|template|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi,
    ' '
  );
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(
    /<\/(p|div|li|tr|h[1-6]|dd|dt|section|article|header|footer|ul|ol|table|blockquote)>/gi,
    '\n'
  );
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  /* JSON 문자열에서 넘어온 역슬래시-n 표기를 실제 줄바꿈으로 */
  s = s.replace(/\\r\\n|\\n|\\r/g, '\n');
  s = s.replace(/[ \t\f\v\u00a0]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function metaContent(html, prop) {
  const re = new RegExp(
    '<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*>',
    'i'
  );
  const m = html.match(re);
  if (!m) return '';
  const c = m[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]).trim() : '';
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function mainRegion(html) {
  const m = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (m && m[1]) return m[1];
  const b = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return b && b[1] ? b[1] : html;
}

/** 페이지 안의 LD+JSON(구조화 데이터)을 모두 꺼내 펼칩니다. */
function readLdJson(html) {
  const out = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch (e) {
      continue;
    }
    const stack = [data];
    let guard = 0;
    while (stack.length && guard < 50) {
      guard++;
      const cur = stack.shift();
      if (!cur) continue;
      if (Array.isArray(cur)) {
        for (let i = 0; i < cur.length; i++) stack.push(cur[i]);
        continue;
      }
      if (typeof cur !== 'object') continue;
      out.push(cur);
      if (Array.isArray(cur['@graph'])) {
        for (let g = 0; g < cur['@graph'].length; g++) stack.push(cur['@graph'][g]);
      }
    }
  }
  return out;
}

function typeOf(obj) {
  const t = obj && obj['@type'];
  if (Array.isArray(t)) return t.join(',');
  return String(t || '');
}

function firstString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const s = firstString(v[i]);
      if (s) return s;
    }
    return '';
  }
  if (typeof v === 'object') return firstString(v.name || v.value || '');
  return '';
}

/* ==================== 가격 통계 ==================== */

function median(sorted) {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(sorted, f) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * f;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function roundWon(n) {
  n = Number(n);
  if (!isFinite(n)) return 0;
  if (n >= 100000) return Math.round(n / 1000) * 1000;
  if (n >= 10000) return Math.round(n / 100) * 100;
  return Math.round(n);
}

/** 0원(무료나눔)과 터무니없는 값을 걸러 냅니다. */
function filterPrices(prices) {
  const positive = prices.filter(function (p) {
    return p > 0;
  });
  const freeCount = prices.length - positive.length;
  if (positive.length < 8) {
    return {
      prices: positive,
      freeCount: freeCount,
      outliers: [],
      lo: 0,
      hi: Infinity,
      trimmed: false,
    };
  }
  const sorted = positive.slice().sort(function (a, b) {
    return a - b;
  });
  const med = median(sorted);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = Math.max(500, med * 0.05, q1 - 1.5 * iqr);
  /* 비싼 쪽은 상태·구성이 좋은 매물이 섞이는 게 자연스러워 조금 넓게 잡습니다. */
  const hi = q3 + 3 * iqr;

  const kept = [];
  const outliers = [];
  for (let i = 0; i < positive.length; i++) {
    const p = positive[i];
    if (p >= lo && p <= hi) kept.push(p);
    else outliers.push(p);
  }
  /* 필터가 너무 많이 지워 버리면(표본이 적을 때) 원래 값으로 돌아갑니다. */
  if (kept.length < 3) {
    return {
      prices: positive,
      freeCount: freeCount,
      outliers: [],
      lo: 0,
      hi: Infinity,
      trimmed: false,
    };
  }
  return {
    prices: kept,
    freeCount: freeCount,
    outliers: outliers,
    lo: lo,
    hi: hi,
    trimmed: true,
  };
}

function pickSamples(items, max) {
  const limit = max || 10;
  if (!items.length) return [];
  const sorted = items.slice().sort(function (a, b) {
    return a.price - b.price;
  });
  if (sorted.length <= limit) {
    return sorted.map(slimSample);
  }
  const picked = [sorted[0]];
  for (let i = 1; i < limit - 1; i++) {
    picked.push(sorted[Math.round((i * (sorted.length - 1)) / (limit - 1))]);
  }
  picked.push(sorted[sorted.length - 1]);

  const seen = {};
  const out = [];
  for (let k = 0; k < picked.length; k++) {
    const it = picked[k];
    const key = it.url || it.title + '|' + it.price;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push(slimSample(it));
  }
  return out.sort(function (a, b) {
    return a.price - b.price;
  });
}

function slimSample(it) {
  return {
    title: String(it.title || '').slice(0, 90),
    price: it.price,
    url: it.url || '',
    image: it.image || '',
  };
}

/* ==================== 당근 검색 결과 파싱 ==================== */

function priceFromOffer(offers) {
  if (!offers) return 0;
  const list = Array.isArray(offers) ? offers : [offers];
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o) continue;
    let v = o.price != null ? o.price : o.lowPrice != null ? o.lowPrice : null;
    if (v == null) continue;
    if (typeof v === 'object') v = v.value != null ? v.value : v.amount;
    const n = Number(String(v).replace(/[^0-9.]/g, ''));
    if (isFinite(n) && n >= 0) return Math.round(n);
  }
  return 0;
}

function parseDaangnItems(html) {
  const nodes = readLdJson(html);
  let items = [];
  let totalFound = 0;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (typeOf(node).indexOf('ItemList') < 0) continue;
    const els = node.itemListElement;
    if (!Array.isArray(els)) continue;
    for (let k = 0; k < els.length; k++) {
      const raw = els[k] && els[k].item ? els[k].item : els[k];
      if (!raw) continue;
      const title = firstString(raw.name || raw.headline || '');
      if (!title) continue;
      items.push({
        title: title.replace(/\s+/g, ' ').trim(),
        price: priceFromOffer(raw.offers),
        url: firstString(raw.url || ''),
        image: firstString(raw.image || ''),
        description: '',
      });
    }
    const n = Number(node.numberOfItems);
    if (isFinite(n) && n > totalFound) totalFound = n;
  }

  /* 구조화 데이터가 없을 때를 위한 여분의 파서 (앵커 + 가격 글자) */
  if (!items.length) {
    const re =
      /<a[^>]+href="([^"]*\/kr\/buy-sell\/[^"]+)"[^>]*>([\s\S]{0,1200}?)<\/a>/gi;
    let m;
    const seen = {};
    while ((m = re.exec(html)) !== null && items.length < 200) {
      const href = decodeEntities(m[1]);
      const inner = m[2];
      const pm = inner.match(/([0-9][0-9,]{2,})\s*원/);
      if (!pm) continue;
      if (seen[href]) continue;
      seen[href] = 1;
      const alt = inner.match(/alt="([^"]*)"/i);
      const title = alt
        ? decodeEntities(alt[1]).trim()
        : htmlToText(inner).replace(/\n/g, ' ').trim();
      if (!title) continue;
      items.push({
        title: title.slice(0, 120),
        price: Number(pm[1].replace(/,/g, '')),
        url: href.indexOf('http') === 0 ? href : 'https://www.daangn.com' + href,
        image: '',
        description: '',
      });
    }
    totalFound = items.length;
  }

  return { items: items, totalFound: totalFound };
}

/** 검색어 낱말이 제목에 하나라도 들어 있는 매물만 '관련 매물'로 봅니다.
 *  (당근이 검색 결과가 없을 때 끼워 넣는 추천 매물을 걸러 내기 위함) */
function relevanceTokens(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[\[\](){}<>"'`,.!?~\/\\:;+*]/g, ' ')
    .split(/\s+/)
    .map(function (t) {
      return t.replace(/(중고|삽니다|팝니다|구매|판매)$/, '');
    })
    .filter(function (t) {
      return t.length >= 2;
    })
    .slice(0, 6);
}

function isRelevant(title, tokens) {
  if (!tokens.length) return true;
  const t = normTitle(title);
  for (let i = 0; i < tokens.length; i++) {
    if (t.indexOf(normTitle(tokens[i])) >= 0) return true;
  }
  return false;
}

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 검색어에 걸린 매물 중 실제 상품과 관련된 것만 고릅니다.
 *  (낱말이 모두 들어간 매물을 우선 쓰고, 너무 적으면 하나라도 들어간 매물로 넓힙니다.) */
function matchItems(items, q) {
  const tokens = relevanceTokens(q);
  if (!tokens.length) return items;
  const all = items.filter(function (it) {
    const t = normTitle(it.title);
    for (let i = 0; i < tokens.length; i++) {
      if (t.indexOf(normTitle(tokens[i])) < 0) return false;
    }
    return true;
  });
  if (all.length >= 5) return all;
  return items.filter(function (it) {
    return isRelevant(it.title, tokens);
  });
}

/* 본품이 아니라 케이스·부품처럼 싼 매물이 섞여 중앙값을 끌어내리는 것을 막습니다.
   검색어 자체가 그 낱말을 담고 있으면(예: '아이폰 케이스') 거르지 않습니다. */
const ACCESSORY_WORDS = [
  '케이스',
  '필름',
  '강화유리',
  '보호유리',
  '거치대',
  '케이블',
  '충전기',
  '어댑터',
  '파우치',
  '스트랩',
  '커버',
  '부품',
  '액정',
  '빈박스',
  '박스만',
  '노즐',
  '리필',
  '소모품',
  '삽니다',
  '삽니당',
  '구합니다',
  '구해요',
  '매입',
  '목업',
];

function splitAccessories(items, q) {
  const qn = normTitle(q);
  const words = ACCESSORY_WORDS.filter(function (w) {
    return qn.indexOf(w) < 0;
  });
  if (!words.length) return { kept: items, removed: [] };
  const kept = [];
  const removed = [];
  for (let i = 0; i < items.length; i++) {
    const t = normTitle(items[i].title);
    let hit = false;
    for (let k = 0; k < words.length; k++) {
      if (t.indexOf(words[k]) >= 0) {
        hit = true;
        break;
      }
    }
    if (hit) removed.push(items[i]);
    else kept.push(items[i]);
  }
  return { kept: kept, removed: removed };
}

function naverShopUrl(q) {
  return (
    'https://search.shopping.naver.com/search/all?query=' +
    encodeURIComponent(q)
  );
}

function joongnaUrl(q) {
  return 'https://web.joongna.com/search/' + encodeURIComponent(q);
}

function daangnWebUrl(q) {
  return (
    'https://www.daangn.com/kr/buy-sell/?search=' +
    encodeURIComponent(q) +
    '&only_on_sale=true'
  );
}

function cleanQuery(q) {
  return String(q || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/* ==================== 1) 실시간 시세 ==================== */

async function handlePrice(url) {
  const q = cleanQuery(url.searchParams.get('q'));
  if (!q) {
    return fail(
      'missing_query',
      '상품명(q)을 넣어 주세요. 예) /?action=price&q=노부영',
      400
    );
  }

  const key = 'price:' + q;
  const hit = cacheGet(key);
  if (hit) {
    return json(Object.assign({}, hit, { cached: true }));
  }

  const target = daangnWebUrl(q);
  let fetched;
  try {
    fetched = await safeFetch(target, PRICE_HOSTS);
  } catch (e) {
    return fail(
      e.code || 'fetch_failed',
      e.message || '당근 검색 페이지를 불러오지 못했어요.',
      e.status || 502,
      { action: 'price', query: q, links: fallbackLinks(q) }
    );
  }

  if (fetched.status >= 400) {
    return fail(
      'upstream_error',
      '당근 검색 페이지가 응답하지 않았어요. (HTTP ' +
        fetched.status +
        ') 잠시 뒤 다시 해 주세요.',
      502,
      { action: 'price', query: q, links: fallbackLinks(q) }
    );
  }

  const html = await readBody(fetched.res, PRICE_MAX_BYTES);
  const parsed = parseDaangnItems(html);
  const matched = matchItems(parsed.items, q);
  const acc = splitAccessories(matched, q);
  const relevant = acc.kept.length >= 3 ? acc.kept : matched;
  const accessoryCount = acc.kept.length >= 3 ? acc.removed.length : 0;
  const readCount = relevant.length + accessoryCount;

  const prices = relevant.map(function (it) {
    return it.price;
  });
  const filtered = filterPrices(prices);
  const statsSource = filtered.prices.slice().sort(function (a, b) {
    return a - b;
  });

  const notes = [];
  notes.push(
    '당근 웹 검색은 동네를 좁히지 않아 전국 매물 기준이에요. 우리 동네 가격은 당근 앱에서 한 번 더 확인해 주세요.'
  );
  if (accessoryCount > 0) {
    notes.push(
      '케이스·부품·구합니다 글처럼 본품이 아닌 매물 ' +
        accessoryCount +
        '건은 계산에서 뺐어요.'
    );
  }
  if (filtered.freeCount > 0) {
    notes.push(
      '무료나눔(0원) ' +
        filtered.freeCount +
        '건은 평균 계산에서 뺐어요.'
    );
  }
  if (filtered.outliers.length > 0) {
    notes.push(
      '구성이 다르거나 가격이 크게 튀는 매물 ' +
        filtered.outliers.length +
        '건은 평균에서 뺐어요.'
    );
  }

  let status = 'ok';
  let stats = null;
  if (!relevant.length) {
    status = 'no_result';
    notes.unshift(
      '당근에서 ‘' +
        q +
        '’(으)로 걸린 매물을 찾지 못했어요. 검색어를 짧게 줄이거나 다른 이름으로 다시 해 보세요.'
    );
  } else if (!statsSource.length) {
    status = 'no_prices';
    notes.unshift(
      '매물은 있었지만 가격이 붙은 매물이 없어요(무료나눔 ' +
        filtered.freeCount +
        '건).'
    );
  } else {
    const avg = Math.round(
      statsSource.reduce(function (a, b) {
        return a + b;
      }, 0) / statsSource.length
    );
    stats = {
      count: statsSource.length,
      avg: roundWon(avg),
      median: roundWon(median(statsSource)),
      min: Math.round(statsSource[0]),
      max: Math.round(statsSource[statsSource.length - 1]),
      p25: roundWon(quantile(statsSource, 0.25)),
      p75: roundWon(quantile(statsSource, 0.75)),
      honey: roundWon(median(statsSource) * 0.7),
      spread:
        quantile(statsSource, 0.25) > 0
          ? Math.round(
              (quantile(statsSource, 0.75) / quantile(statsSource, 0.25)) * 10
            ) / 10
          : 0,
    };
    if (stats.spread >= 4 && stats.count >= 8) {
      notes.push(
        '가격이 넓게 퍼져 있어요(상태·구성 차이). 숫자 하나보다 아래 샘플 매물과 당근 링크를 함께 보세요.'
      );
    }
    if (stats.count < 8) {
      notes.push('표본이 ' + stats.count + '건뿐이라 참고용으로만 봐 주세요.');
    }
  }

  const body = {
    ok: true,
    status: status,
    action: 'price',
    query: q,
    region: '전국',
    source: { name: '당근마켓', url: fetched.finalUrl },
    totalFound: parsed.totalFound || parsed.items.length,
    parsedCount: parsed.items.length,
    matchedCount: readCount,
    accessoryCount: accessoryCount,
    freeCount: filtered.freeCount,
    outlierCount: filtered.outliers.length,
    stats: stats,
    samples: stats
      ? pickSamples(
          relevant.filter(function (it) {
            if (it.price <= 0) return false;
            if (!filtered.trimmed) return true;
            return it.price >= filtered.lo && it.price <= filtered.hi;
          }),
          10
        )
      : [],
    links: fallbackLinks(q),
    notes: notes,
    fetchedAt: new Date().toISOString(),
  };

  if (status === 'ok') cacheSet(key, body, CACHE_TTL_PRICE);
  return json(body);
}

function fallbackLinks(q) {
  return {
    daangn: daangnWebUrl(q),
    naver: naverShopUrl(q),
    joongna: joongnaUrl(q),
    daangnJobs: 'https://jobs.daangn.com/',
  };
}

/* ==================== 2) 알바 공고 읽기 ==================== */

const UNIT_LABEL = {
  HOUR: '시급',
  MONTH: '월급',
  DAY: '일급',
  WEEK: '주급',
  YEAR: '연봉',
  HOURLY: '시급',
  MONTHLY: '월급',
  DAILY: '일급',
  ANNUAL: '연봉',
};

function payOf(ld) {
  const bs = ld.baseSalary || ld.estimatedSalary;
  if (!bs) return { text: '', amount: 0, unit: '' };
  const list = Array.isArray(bs) ? bs : [bs];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b) continue;
    let v = b.value;
    let unit = '';
    if (v && typeof v === 'object') {
      unit = firstString(v.unitText || '');
      v = v.value != null ? v.value : v.minValue;
    }
    if (v == null) continue;
    const n = Number(String(v).replace(/[^0-9.]/g, ''));
    if (!isFinite(n) || n <= 0) continue;
    const label = UNIT_LABEL[String(unit).toUpperCase()] || '급여';
    return {
      text: label + ' ' + n.toLocaleString('ko-KR') + '원',
      amount: Math.round(n),
      unit: String(unit).toUpperCase(),
    };
  }
  return { text: '', amount: 0, unit: '' };
}

function addressOf(ld) {
  let loc = ld.jobLocation || ld.jobLocationType;
  if (!loc) return '';
  if (Array.isArray(loc)) loc = loc[0];
  if (!loc) return '';
  const a = loc.address || loc;
  if (typeof a === 'string') return a;
  const region = firstString(a.addressRegion);
  const locality = firstString(a.addressLocality);
  const street = firstString(a.streetAddress);

  /* streetAddress 안에 이미 지역명이 들어 있으면 겹쳐 쓰지 않습니다. */
  let out = '';
  if (street) {
    const hasLoc = !!locality && street.indexOf(locality) >= 0;
    const hasRegion =
      !!region &&
      (street.indexOf(region) >= 0 ||
        (region.length > 2 && street.indexOf(region.slice(0, 2)) >= 0));
    if ((hasRegion || !region) && (hasLoc || !locality)) {
      out = street;
    } else {
      const prefix = [hasRegion ? '' : region, hasLoc ? '' : locality]
        .filter(Boolean)
        .join(' ');
      out = prefix ? prefix + ' ' + street : street;
    }
  } else {
    out = [region, locality].filter(Boolean).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function employmentOf(ld) {
  const t = ld.employmentType;
  const list = Array.isArray(t) ? t : t ? [t] : [];
  const map = {
    FULL_TIME: '정규직(풀타임)',
    PART_TIME: '아르바이트(파트타임)',
    CONTRACTOR: '계약직',
    TEMPORARY: '단기',
    INTERN: '인턴',
    VOLUNTEER: '자원봉사',
    PER_DIEM: '일당직',
    OTHER: '기타',
  };
  return list
    .map(function (x) {
      const k = String(x).toUpperCase();
      return map[k] || String(x);
    })
    .join(', ');
}

function shortDate(v) {
  const s = String(v || '');
  const m = s.match(/(\d{4})[-.](\d{2})[-.](\d{2})/);
  if (!m) return s.slice(0, 16);
  return m[1] + '-' + m[2] + '-' + m[3];
}

/** 마감된 공고인지 봅니다. (사이트별 '마감' 안내 문구 + 모집마감일이 지난 경우) */
function isClosedJob(html, deadline) {
  if (/이 공고는 마감되었어요|구인마감/.test(html)) return true;
  if (/모집이 마감되었|마감된 공고입니다|채용이 마감되었/.test(html)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(deadline || ''))) {
    /* 한국 시간 기준 오늘 */
    const today = new Date(Date.now() + 9 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    if (deadline < today) return true;
  }
  return false;
}

/** 페이지 본문에서 '근무요일 / 근무시간 / 근무지역' 같은 항목을 뽑습니다. */
const FIELD_LABELS = [
  ['근무요일', 40],
  ['근무시간', 50],
  ['근무기간', 40],
  ['근무지역', 90],
  ['근무지정보', 90],
  ['모집마감', 30],
  ['고용형태', 20],
  ['급여', 45],
];

function labeledField(text, label, maxLen) {
  /* 라벨 뒤에는 콜론이나 공백/줄바꿈이 와야 합니다.
     ("급여가 최저임금…" 같은 문장을 급여 항목으로 잘못 잡지 않도록) */
  const re = new RegExp(
    '(?:^|\\n)\\s*' + label + '(?:\\s*[:：]\\s*|\\s+)([^\\n]{1,' + maxLen + '})'
  );
  const m = text.match(re);
  if (!m) return '';
  return m[1]
    .replace(/\s+/g, ' ')
    .replace(/\s*(복사|길찾기|지도보기|더보기|상세보기|바로채용)\s*$/, '')
    .replace(/[·ㆍ]+\s*$/, '')
    .trim()
    .slice(0, maxLen);
}

/** 공고 본문에서 급여 줄을 찾습니다. (구조화 데이터가 없는 사이트 대비) */
function payFromText(text) {
  const t = String(text || '');
  let m = t.match(
    /(?:^|\n)\s*급여\s*\n?\s*((?:시급|월급|일급|연봉|주급|건당)[^\n]{0,32})/
  );
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  m = t.match(/(?:^|\n)\s*(시급|월급|일급|연봉|주급|건당)\s*\n\s*([0-9][0-9,]*(?:\.\d+)?\s*원)/);
  if (m) return m[1] + ' ' + m[2].replace(/\s+/g, '');
  return '';
}

function companyFromTitle(title) {
  const m = String(title || '').match(/^(.{2,40}?)\s*채용정보/);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function stripBoilerplate(text) {
  const bad = [
    '최저시급',
    '급여계산기',
    '제트캐시',
    '알바몬에서 보고',
    '비슷한 조건',
    'AI 추천',
    '본 정보는',
    '부적합 공고',
    '상세요강',
    '회원가입',
    '전체메뉴',
    '고객지원',
    '개인정보 처리방침',
    '운영정책',
    '사업자번호',
    '통신판매업',
    '맨위로',
    '스크랩',
    '관심기업',
  ];
  return String(text || '')
    .split('\n')
    .filter(function (line) {
      const l = line.trim();
      if (!l) return false;
      for (let i = 0; i < bad.length; i++) {
        if (l.indexOf(bad[i]) >= 0) return false;
      }
      return true;
    })
    .join('\n');
}

function parseJobPage(html, finalUrl) {
  const host = new URL(finalUrl).hostname.toLowerCase();
  let site = '공고';
  if (hostAllowed(host, ['daangn.com'])) {
    site = /\/jobs\//.test(finalUrl) || host.indexOf('jobs.') === 0 ? '당근알바' : '당근';
  } else if (hostAllowed(host, ['albamon.com'])) {
    site = '알바몬';
  } else if (hostAllowed(host, ['alba.co.kr'])) {
    site = '알바천국';
  }

  const nodes = readLdJson(html);
  let ld = null;
  for (let i = 0; i < nodes.length; i++) {
    if (typeOf(nodes[i]).indexOf('JobPosting') >= 0) {
      ld = nodes[i];
      break;
    }
  }

  const ogTitle = metaContent(html, 'og:title');
  const ogDesc = metaContent(html, 'og:description');
  const ogImage = metaContent(html, 'og:image');
  const title =
    (ld && firstString(ld.title)) || ogTitle || titleOf(html) || site + ' 공고';

  /* 근무 조건은 본문 글에서도 확인합니다(사이트마다 구조화 데이터가 빈약함). */
  const bodyLines = stripBoilerplate(htmlToText(mainRegion(html)));

  const fields = {};
  for (let i = 0; i < FIELD_LABELS.length; i++) {
    const label = FIELD_LABELS[i][0];
    const v = labeledField(bodyLines, label, FIELD_LABELS[i][1]);
    if (v) fields[label] = v;
  }

  let company = ld ? firstString(ld.hiringOrganization) : '';
  if (!company) company = companyFromTitle(title);

  const pay = ld ? payOf(ld) : { text: '', amount: 0, unit: '' };
  let payText = pay.text;
  if (!payText) {
    payText = fields['급여'] || payFromText(bodyLines);
    /* "급여 : 월급 2,670,000원" → "월급 2,670,000원" */
    const pm = payText.match(/(시급|월급|일급|연봉|주급)[^0-9]{0,6}([0-9][0-9,]*)\s*원/);
    if (pm) payText = pm[1] + ' ' + pm[2] + '원';
    else if (!/[0-9]/.test(payText)) payText = '';
  }

  let address = ld ? addressOf(ld) : '';
  if (!address) address = fields['근무지역'] || fields['근무지정보'] || '';

  const rawHours = ld ? firstString(ld.workHours) : '';
  /* "풀타임"처럼 시간이 아닌 값이면 본문의 근무시간을 먼저 씁니다. */
  const hoursIsTime = /\d{1,2}\s*[:시]/.test(rawHours);
  const workHours = hoursIsTime
    ? rawHours
    : fields['근무시간'] || rawHours || '';

  const employment = ld ? employmentOf(ld) : fields['고용형태'] || '';
  const deadline = ld ? shortDate(ld.validThrough) : fields['모집마감'] || '';
  const postedAt = ld ? shortDate(ld.datePosted) : '';
  const descText = ld ? htmlToText(ld.description || '') : '';

  const lines = [];
  lines.push(title);
  if (site) lines.push('올린 곳: ' + site);
  if (company) lines.push('사업장: ' + company);
  if (payText) lines.push('급여: ' + payText);
  if (workHours && workHours.replace(/\s/g, '').length > 1) {
    lines.push('근무시간: ' + workHours);
  }
  if (fields['근무요일']) lines.push('근무요일: ' + fields['근무요일']);
  if (fields['근무기간']) lines.push('근무기간: ' + fields['근무기간']);
  if (address) lines.push('근무지: ' + address);
  if (employment) lines.push('고용형태: ' + employment);
  if (deadline) lines.push('모집마감: ' + deadline);
  if (postedAt) lines.push('등록일: ' + postedAt);

  const parts = [lines.join('\n')];
  if (descText) parts.push('[공고 내용]\n' + descText);

  let text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > 6000) text = text.slice(0, 6000);

  const closed = isClosedJob(html, deadline);

  return {
    title: title.replace(/\s+/g, ' ').trim(),
    text: text,
    site: site,
    closed: closed,
    meta: {
      company: company,
      pay: payText,
      payAmount: pay.amount,
      payUnit: pay.unit,
      workHours: workHours,
      workDays: fields['근무요일'] || '',
      address: address,
      employmentType: employment,
      deadline: deadline,
      postedAt: postedAt,
      image: ogImage,
      description: ogDesc,
      hasJobPostingData: !!ld,
    },
  };
}

async function handleJob(url) {
  const raw = String(url.searchParams.get('url') || '').trim();
  if (!raw) {
    return fail(
      'missing_url',
      '공고 주소(url)를 넣어 주세요. 예) /?action=job&url=https://jobs.daangn.com/job-posts/...',
      400
    );
  }

  let probe;
  try {
    probe = new URL(raw);
  } catch (e) {
    return fail('bad_url', '주소 형식이 올바르지 않아요. https:// 로 시작하는 링크를 넣어 주세요.', 400);
  }
  if (probe.protocol !== 'https:' || !hostAllowed(probe.hostname, JOB_HOSTS)) {
    return fail(
      'domain_not_allowed',
      '당근(daangn.com)·당근알바(jobs.daangn.com)·알바몬(albamon.com)·알바천국(alba.co.kr) 공고 링크만 읽을 수 있어요.',
      400
    );
  }

  const key = 'job:' + probe.toString();
  const hit = cacheGet(key);
  if (hit) return json(Object.assign({}, hit, { cached: true }));

  let fetched;
  try {
    fetched = await safeFetch(probe.toString(), JOB_HOSTS);
  } catch (e) {
    return fail(
      e.code || 'fetch_failed',
      e.message || '공고 페이지를 불러오지 못했어요.',
      e.status || 502,
      { action: 'job', sourceUrl: probe.toString() }
    );
  }

  if (fetched.status >= 400) {
    return fail(
      'upstream_error',
      '공고 페이지가 응답하지 않았어요. (HTTP ' +
        fetched.status +
        ') 링크가 맞는지 확인해 주세요.',
      502,
      { action: 'job', sourceUrl: probe.toString() }
    );
  }

  const html = await readBody(fetched.res, JOB_MAX_BYTES);
  let parsed;
  try {
    parsed = parseJobPage(html, fetched.finalUrl);
  } catch (e) {
    return fail(
      'parse_failed',
      '공고 내용을 알아보지 못했어요. 공고 글을 직접 복사해서 붙여넣어 주세요.',
      502,
      { action: 'job', sourceUrl: fetched.finalUrl }
    );
  }

  if (!parsed.text || parsed.text.length < 12) {
    return fail(
      'empty_content',
      '공고 내용을 읽지 못했어요. 사진 캡처나 글 붙여넣기를 이용해 주세요.',
      422,
      { action: 'job', sourceUrl: fetched.finalUrl }
    );
  }

  const notes = [];
  if (parsed.closed) {
    notes.push('이 공고는 이미 마감된 것으로 보여요. 비슷한 다른 공고를 확인해 보세요.');
  }
  notes.push(
    '공고에 적힌 내용만 읽었어요. 실제 근무 조건은 지원 전에 사장님께 한 번 더 확인해 주세요.'
  );

  const body = {
    ok: true,
    status: 'ok',
    action: 'job',
    title: parsed.title,
    text: parsed.text,
    site: parsed.site,
    sourceUrl: fetched.finalUrl,
    requestedUrl: probe.toString(),
    closed: parsed.closed,
    meta: parsed.meta,
    notes: notes,
    fetchedAt: new Date().toISOString(),
  };

  cacheSet(key, body, CACHE_TTL_JOB);
  return json(body);
}

/* ==================== 라우터 ==================== */

const HELP = {
  ok: true,
  name: APP_NAME,
  version: VERSION,
  description:
    '살까말까 앱의 무료 미니 서버예요. 실시간 시세와 알바 공고 읽기를 맡습니다.',
  endpoints: {
    price: '/?action=price&q=검색어',
    job: '/?action=job&url=공고주소',
    ping: '/?action=ping',
  },
};

export default {
  async fetch(request) {
    const method = request.method || 'GET';

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (method !== 'GET' && method !== 'HEAD') {
      return fail('method_not_allowed', 'GET 요청만 받아요.', 405);
    }

    const url = new URL(request.url);
    const action = String(url.searchParams.get('action') || '')
      .trim()
      .toLowerCase();

    try {
      if (action === 'price') return await handlePrice(url);
      if (action === 'job') return await handleJob(url);
      if (!action || action === 'help' || action === 'ping') {
        return json(HELP);
      }
      return fail(
        'unknown_action',
        'action은 price 또는 job 이어야 해요.',
        400,
        { actions: ['price', 'job', 'ping'] }
      );
    } catch (e) {
      return fail(
        'server_error',
        '서버에서 처리하다가 문제가 생겼어요. 잠시 뒤 다시 해 주세요.',
        500,
        { detail: String((e && e.message) || e).slice(0, 200) }
      );
    }
  },
};
