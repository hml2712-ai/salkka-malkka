/* 살까말까 서비스 워커 — 홈 화면 앱이 인터넷이 없어도 열리게 해 줍니다.
   캐시 이름의 버전을 올리면 예전 화면이 자동으로 정리됩니다.
   (v2: 사진 글자 인식(OCR) 추가. Tesseract.js는 외부 CDN에서 받아오므로
    아래 fetch 핸들러가 same-origin만 다루어 CDN 요청은 건드리지 않습니다.)
   (v3: 실시간 시세·알바 링크 서버 연결. Worker는 다른 주소라 캐시하지 않습니다.)
   (v4: 알바 링크 칸에 제목·설명이 섞여 있어도 URL만 골라 읽고,
    공식 플랫폼 공고의 전화번호 미기재를 감점하지 않도록 판정 기준을 조정했습니다.)
   (v5: 검색어 오타·띄어쓰기 자동 보정과 유사어 재검색을 추가했습니다. Worker는 그대로입니다.) */
var CACHE = 'salkka-malkka-v5';
var ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); }).catch(function(){}));
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET'){ return; }
  if(new URL(req.url).origin !== self.location.origin){ return; }

  /* 네트워크 우선 — 새 배포가 있으면 바로 반영하고, 실패하면 캐시로 연다 */
  e.respondWith(
    fetch(req).then(function(res){
      var copy = res.clone();
      caches.open(CACHE).then(function(c){ c.put(req, copy); }).catch(function(){});
      return res;
    }).catch(function(){
      return caches.match(req).then(function(hit){
        if(hit){ return hit; }
        if(req.mode === 'navigate'){ return caches.match('./index.html'); }
        return Response.error();
      });
    })
  );
});
