/* =====================================================================
 * app.js — 컨트롤러: 파일 입력/드래그, 변환 디스패치, 미리보기, PDF 출력
 * ===================================================================== */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var PX_PER_MM = 96 / 25.4;

  var els = {};
  var state = { files: [], current: null, zoom: 1 };
  var uid = 0;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    els = {
      dropzone: $('#dropzone'), fileInput: $('#fileInput'), pickBtn: $('#pickBtn'),
      queueWrap: $('#queueWrap'), queue: $('#queue'), clearBtn: $('#clearBtn'),
      viewer: $('#viewer'), sheet: $('#sheet'), paper: $('#paper'),
      docName: $('#docName'), docMeta: $('#docMeta'),
      zoomIn: $('#zoomIn'), zoomOut: $('#zoomOut'), zoomVal: $('#zoomVal'),
      btnPrint: $('#btnPrint'), btnImgPdf: $('#btnImgPdf'),
      printStyle: $('#printStyle'), toast: $('#toast'),
      busy: $('#busy'), busyText: $('#busyText'),
      openLegal: $('#openLegal'), closeLegal: $('#closeLegal'), legalModal: $('#legalModal'),
      zipAllBtn: $('#zipAllBtn'), btnMore: $('#btnMore'), morePop: $('#morePop'),
      exPng: $('#exPng'), exMdCopy: $('#exMdCopy'), exMdFile: $('#exMdFile'),
      themeToggle: $('#themeToggle'), installBtn: $('#installBtn')
    };

    els.pickBtn.addEventListener('click', function (e) { e.stopPropagation(); els.fileInput.click(); });
    els.dropzone.addEventListener('click', function () { els.fileInput.click(); });
    els.dropzone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') els.fileInput.click(); });
    els.fileInput.addEventListener('change', function (e) { addFiles(e.target.files); els.fileInput.value = ''; });

    ['dragenter', 'dragover'].forEach(function (ev) {
      els.dropzone.addEventListener(ev, function (e) { e.preventDefault(); els.dropzone.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      els.dropzone.addEventListener(ev, function (e) { e.preventDefault(); els.dropzone.classList.remove('drag'); });
    });
    els.dropzone.addEventListener('drop', function (e) { if (e.dataTransfer) addFiles(e.dataTransfer.files); });
    // 페이지 어디든 드롭 허용
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.target.closest && e.target.closest('#dropzone')) return;
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    els.clearBtn.addEventListener('click', clearAll);
    els.zoomIn.addEventListener('click', function () { setZoom(state.zoom + 0.1); });
    els.zoomOut.addEventListener('click', function () { setZoom(state.zoom - 0.1); });
    els.btnPrint.addEventListener('click', doPrint);
    els.btnImgPdf.addEventListener('click', doImagePdf);

    // 내보내기 메뉴 + 출력 기능
    els.btnMore.addEventListener('click', function (e) {
      e.stopPropagation(); var open = els.morePop.hidden;
      els.morePop.hidden = !open; els.btnMore.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.menu')) { els.morePop.hidden = true; els.btnMore.setAttribute('aria-expanded', 'false'); }
    });
    els.exPng.addEventListener('click', function () { els.morePop.hidden = true; doExportPng(); });
    els.exMdCopy.addEventListener('click', function () { els.morePop.hidden = true; doMarkdown(true); });
    els.exMdFile.addEventListener('click', function () { els.morePop.hidden = true; doMarkdown(false); });
    els.zipAllBtn.addEventListener('click', doZipAll);

    // 수식 클릭 → LaTeX 복사
    els.sheet.addEventListener('click', function (e) {
      var eq = e.target.closest && e.target.closest('.hp-eq[data-latex]');
      if (eq && eq.getAttribute('data-latex')) {
        Exporters.copyText(eq.getAttribute('data-latex')).then(function (ok) {
          toast(ok ? 'LaTeX 복사됨: ' + eq.getAttribute('data-latex').slice(0, 40) : '복사 실패', ok ? 'ok' : 'err');
        });
      }
    });

    // 다크 모드
    initTheme();
    els.themeToggle.addEventListener('click', toggleTheme);

    // PWA 설치
    initInstall();

    // 법적 고지 모달 (포커스 이동/복원)
    els.openLegal.addEventListener('click', function () {
      legalReturnFocus = document.activeElement;
      els.legalModal.hidden = false; els.closeLegal.focus();
    });
    els.closeLegal.addEventListener('click', closeLegal);
    els.legalModal.addEventListener('click', function (e) { if (e.target.hasAttribute('data-close')) closeLegal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !els.legalModal.hidden) closeLegal(); });

    // 테스트용 훅 (preview_eval 에서 사용)
    window.__hwp = {
      loadUrl: function (url, name) {
        return fetch(url).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
          return addBuffer(buf, name || url.split('/').pop());
        });
      },
      state: state
    };
  }

  // ---- 큐 관리 -------------------------------------------------------
  function addFiles(fileList) {
    var arr = Array.prototype.slice.call(fileList || []);
    arr.forEach(function (file) {
      var ext = (file.name.split('.').pop() || '').toLowerCase();
      if (ext !== 'hwp' && ext !== 'hwpx' && ext !== 'docx') { toast('지원하지 않는 형식: ' + file.name + ' (.hwp/.hwpx/.docx)', 'err'); return; }
      var reader = new FileReader();
      reader.onload = function () { addBuffer(reader.result, file.name); };
      reader.onerror = function () { toast('파일을 읽을 수 없습니다: ' + file.name, 'err'); };
      reader.readAsArrayBuffer(file);
    });
  }

  function addBuffer(arrayBuffer, name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var kind = sniffFormat(arrayBuffer, ext);
    var f = { id: ++uid, name: name, ext: ext, kind: kind, buf: arrayBuffer, status: 'pending', rendered: null, error: null };
    state.files.push(f);
    els.queueWrap.hidden = false;
    renderQueue();
    return processFile(f);
  }

  // 확장자가 아니라 실제 내용(매직바이트)으로 형식을 판별한다.
  //  · OLE/CFB(D0 CF 11 E0 …) = 구형 바이너리 HWP — .hwpx 로 잘못 저장/이름변경된 경우가 흔함
  //  · ZIP(PK…) = 진짜 HWPX 또는 DOCX → 확장자로 구분
  function sniffFormat(buf, ext) {
    try {
      var u8 = new Uint8Array(buf, 0, Math.min(8, buf.byteLength || 0));
      if (u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0) return 'hwp';
      if (u8[0] === 0x50 && u8[1] === 0x4B) return (ext === 'docx') ? 'docx' : 'hwpx';
    } catch (e) { /* 판별 실패 시 확장자 신뢰 */ }
    return ext;
  }

  function clearAll() {
    state.files = []; state.current = null;
    els.queue.innerHTML = ''; els.queueWrap.hidden = true; els.viewer.hidden = true;
  }

  function renderQueue() {
    els.queue.innerHTML = '';
    state.files.forEach(function (f) {
      var li = document.createElement('li');
      li.className = 'qitem' + (state.current === f.id ? ' active' : '');
      li.onclick = function () { if (f.status === 'done' || f.status === 'warn') showFile(f); };

      var statTxt = { pending: '대기 중…', working: '변환 중…', done: '완료', warn: '제한적 변환', error: '실패' }[f.status] || '';
      var statCls = f.status === 'done' ? 'ok' : f.status === 'error' ? 'err' : f.status === 'warn' ? 'warn' : '';
      var spinner = (f.status === 'pending' || f.status === 'working') ? '<span class="fspin"></span>' : '';

      li.innerHTML =
        '<span class="ficon ' + (f.kind || f.ext) + '" title="실제 형식: ' + (f.kind || f.ext).toUpperCase() + '">' + (f.kind || f.ext).toUpperCase() + '</span>' +
        '<span class="fmeta"><span class="fname">' + escapeHtml(f.name) + '</span>' +
        '<span class="fstat ' + statCls + '">' + statTxt + (f.error ? ' · ' + escapeHtml(f.error) : '') + '</span></span>' +
        spinner +
        '<button class="fx" title="제거">×</button>';
      li.querySelector('.fx').onclick = function (e) { e.stopPropagation(); removeFile(f); };
      els.queue.appendChild(li);
    });
    var doneCount = state.files.filter(function (x) { return x.status === 'done' || x.status === 'warn'; }).length;
    els.zipAllBtn.hidden = doneCount < 2;
  }

  function removeFile(f) {
    state.files = state.files.filter(function (x) { return x !== f; });
    if (state.current === f.id) { els.viewer.hidden = true; state.current = null; }
    if (!state.files.length) els.queueWrap.hidden = true;
    renderQueue();
  }

  // ---- 변환 ----------------------------------------------------------
  async function processFile(f) {
    f.status = 'working'; renderQueue();
    try {
      if (f.kind === 'hwpx') {
        f.rendered = await window.HWPX.parse(f.buf.slice(0));
        f.status = 'done';
      } else if (f.kind === 'docx') {
        f.rendered = await window.DOCXX.parse(f.buf.slice(0));
        f.status = 'done';
      } else {
        f.rendered = await renderHwp(f);
        f.status = f.rendered.limited ? 'warn' : 'done';
      }
    } catch (e) {
      console.error('변환 실패:', f.name, e);
      f.status = 'error'; f.error = (e && e.message) ? e.message.slice(0, 70) : '오류';
    }
    renderQueue();
    if ((f.status === 'done' || f.status === 'warn') && state.current == null) showFile(f);
  }

  // ---- 미리보기 마운트 ----------------------------------------------
  function showFile(f) {
    if (!f.rendered) return;
    state.current = f.id; renderQueue();
    els.viewer.hidden = false;

    var m = f.rendered.meta || { page: { wMm: 210, hMm: 297 }, margin: { t: 20, r: 20, b: 20, l: 20 } };
    var pg = m.page, mg = m.margin;

    els.sheet.className = 'sheet';
    els.sheet.style.width = pg.wMm + 'mm';
    els.sheet.style.minHeight = pg.hMm + 'mm';
    els.sheet.style.padding = mg.t + 'mm ' + mg.r + 'mm ' + mg.b + 'mm ' + mg.l + 'mm';
    els.sheet.style.boxSizing = 'border-box';
    els.sheet.innerHTML = f.rendered.html;

    // 인쇄용 @page (문서별 용지/여백)
    els.printStyle.textContent =
      '@media print{ @page{ size:' + round(pg.wMm) + 'mm ' + round(pg.hMm) + 'mm; ' +
      'margin:' + round(mg.t) + 'mm ' + round(mg.r) + 'mm ' + round(mg.b) + 'mm ' + round(mg.l) + 'mm; } }';

    els.docName.textContent = f.name;
    els.docMeta.textContent = (pg.wMm > pg.hMm ? '가로 ' : '') + Math.round(pg.wMm) + '×' + Math.round(pg.hMm) + 'mm' +
      (f.rendered.limited ? ' · 제한적 변환' : '');

    fitWidth(pg.wMm);
    els.paper.scrollTop = 0;
  }

  function fitWidth(wMm) {
    var avail = els.paper.clientWidth - 52;
    var sheetPx = wMm * PX_PER_MM;
    var z = Math.min(1.0, avail / sheetPx);
    setZoom(z > 0.2 ? z : 1);
  }
  function setZoom(z) {
    state.zoom = Math.max(0.2, Math.min(2.5, z));
    els.sheet.style.transform = 'scale(' + state.zoom + ')';
    els.zoomVal.textContent = Math.round(state.zoom * 100) + '%';
  }

  // ---- .hwp (구형 바이너리) : 한글 내장 미리보기(첫 페이지) + 텍스트 -----
  // 구형 .hwp 본문은 OLE 안에 압축 저장돼 브라우저에서 정밀 재현이 어렵습니다.
  // 대신 한글이 저장해 둔 PrvImage(첫 페이지 렌더)·PrvText 를 꺼내 보여줍니다.
  async function renderHwp(f) {
    var CFB;
    try { CFB = await import('https://esm.sh/cfb@1.2.2'); }
    catch (e) { throw new Error('오프라인에서는 .hwp(구형) 변환에 최초 1회 온라인 접속이 필요해요. (.hwpx 는 오프라인 가능)'); }
    var read = CFB.read || (CFB.default && CFB.default.read);
    var find = CFB.find || (CFB.default && CFB.default.find);
    var cfb;
    try { cfb = read(new Uint8Array(f.buf.slice(0)), { type: 'array' }); }
    catch (e) { throw new Error('.hwp 파일을 읽을 수 없습니다 — .hwpx 로 저장 후 시도해 주세요'); }

    // 첫 페이지 미리보기 이미지 (PNG/GIF/JPEG/BMP 자동 판별)
    var imgHtml = '';
    var pi = find(cfb, 'PrvImage') || find(cfb, '/PrvImage');
    if (pi && pi.content && pi.content.length > 8) {
      var b = pi.content;
      var mime = b[0] === 0x89 ? 'image/png'
        : b[0] === 0x47 ? 'image/gif'
        : b[0] === 0xff ? 'image/jpeg'
        : (b[0] === 0x42 && b[1] === 0x4d) ? 'image/bmp' : 'image/png';
      imgHtml = '<img class="hp-prv" src="data:' + mime + ';base64,' + bytesToB64(b) + '" alt="첫 페이지 미리보기" />';
    }

    // 미리보기 텍스트 (UTF-16LE)
    var text = '';
    var pv = find(cfb, 'PrvText') || find(cfb, '/PrvText');
    if (pv && pv.content) {
      text = new TextDecoder('utf-16le').decode(new Uint8Array(pv.content)).replace(/ /g, '').trim();
    }

    var misNote = (f.ext === 'hwpx' || f.ext === 'docx')
      ? '이 파일은 확장자가 <b>.' + f.ext + '</b> 이지만 실제 내용은 <b>구형 .hwp(바이너리)</b> 형식이에요. '
      : '';
    var banner = '<div class="fb-banner">⚠️ ' + misNote + '구형 <b>.hwp</b> 형식은 한글이 저장해 둔 <b>첫 페이지 미리보기</b>로 표시됩니다.<br>' +
      '✅ <b>완전 변환 방법</b> — 한글에서 이 문서를 열고 <b>파일 → 다른 이름으로 저장 → 「한/글 문서 (*.hwpx)」</b> 로 저장한 뒤 그 파일을 올리면 표·서식·수식까지 그대로 변환됩니다. (또는 저장소의 <b>CLI</b> 사용)</div>';

    var body;
    if (imgHtml) {
      body = '<div class="hwp-fallback hwp-prv-wrap">' + banner + imgHtml + '</div>';
    } else if (text && text.length > 1) {
      body = '<div class="hwp-fallback">' + banner + escapeHtml(text) + '</div>';
    } else {
      body = '<div class="hwp-fallback">' + banner + '<i>이 문서에서 추출할 수 있는 미리보기가 없습니다. .hwpx 로 저장 후 변환해 주세요.</i></div>';
    }
    // 미리보기 이미지는 페이지 전체(여백 포함)를 담으므로 여백 0 으로 꽉 채움
    var margin = imgHtml ? { t: 0, r: 0, b: 0, l: 0 } : { t: 20, r: 20, b: 20, l: 20 };
    return { html: body, meta: { page: { wMm: 210, hMm: 297, landscape: false }, margin: margin }, limited: true };
  }

  function bytesToB64(bytes) {
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + CH));
    }
    return btoa(bin);
  }

  // ---- PDF: 인쇄(벡터, 최고 품질) -----------------------------------
  function doPrint() {
    if (state.current == null) return;
    var z = state.zoom;
    setZoom(1);               // 인쇄는 항상 100%
    toast('인쇄 대화상자에서 “대상 → PDF로 저장” 을 선택하세요', 'ok', 3200);
    setTimeout(function () {
      window.print();
      setZoom(z);
    }, 250);
  }

  // ---- 오프스크린 렌더 (화면 줌/다크모드 영향 없이 항상 흰 종이로 캡처) ----
  function offscreenSheet(f) {
    var m = f.rendered.meta, pg = m.page, mg = m.margin;
    var el = document.createElement('div');
    el.className = 'sheet';
    el.style.cssText = 'position:absolute;left:-99999px;top:0;width:' + pg.wMm + 'mm;min-height:' + pg.hMm +
      'mm;padding:' + mg.t + 'mm ' + mg.r + 'mm ' + mg.b + 'mm ' + mg.l + 'mm;box-sizing:border-box;background:#fff;color:#000';
    el.innerHTML = f.rendered.html;
    return el;
  }
  async function fileToCanvas(f, scale) {
    var el = offscreenSheet(f);
    document.body.appendChild(el);
    try {
      // 브라우저 캔버스 한계(≈16384px/변) 안으로 scale 조정 — 긴 문서가 빈/잘린 결과로
      // 조용히 나오는 것을 방지. 한계를 넘으면 인쇄(PDF로 저장)를 안내.
      var s = scale || 2;
      var hPx = el.offsetHeight || (f.rendered.meta.page.hMm * PX_PER_MM);
      var wPx = el.offsetWidth || (f.rendered.meta.page.wMm * PX_PER_MM);
      var MAXSIDE = 16000;
      if (hPx * s > MAXSIDE) s = MAXSIDE / hPx;
      if (wPx * s > MAXSIDE) s = Math.min(s, MAXSIDE / wPx);
      var canvas = await Exporters.sheetToCanvas(el, s);
      if (!canvas || !canvas.width || !canvas.height) {
        throw new Error('문서가 너무 길어 이미지 변환에 실패했어요. “PDF로 저장”(인쇄)을 이용해 주세요');
      }
      return canvas;
    } finally { el.remove(); }
  }
  function ensureLibs() {
    if (!window.Exporters || !window.html2canvas || !window.jspdf || !window.JSZip) {
      toast('필요한 라이브러리를 불러오지 못했어요(네트워크 확인)', 'err'); return false;
    }
    return true;
  }
  function baseName(f) { return f.name.replace(/\.(hwp|hwpx|docx)$/i, ''); }
  function currentFile() { return state.files.find(function (x) { return x.id === state.current; }); }

  // ---- PDF: 이미지(즉시 다운로드) -----------------------------------
  async function doImagePdf() {
    var f = currentFile(); if (!f) return;
    if (!ensureLibs()) return;
    busy(true, '이미지 PDF 생성 중…');
    try {
      var canvas = await fileToCanvas(f, 2);
      Exporters.downloadBlob(Exporters.canvasToPdfBlob(canvas, f.rendered.meta), baseName(f) + '.pdf');
      toast('PDF 다운로드 완료', 'ok');
    } catch (e) { console.error(e); toast('이미지 PDF 실패: ' + (e.message || ''), 'err'); }
    finally { busy(false); }
  }

  // ---- PNG 내보내기 (페이지별; 여러 장이면 ZIP) ----------------------
  async function doExportPng() {
    var f = currentFile(); if (!f) return;
    if (!ensureLibs()) return;
    busy(true, 'PNG 생성 중…');
    try {
      var canvas = await fileToCanvas(f, 2);
      var blobs = await Exporters.canvasToPngBlobs(canvas, f.rendered.meta);
      if (!blobs.length) { toast('내보낼 내용이 없어요', 'err'); return; }
      if (blobs.length === 1) {
        Exporters.downloadBlob(blobs[0], baseName(f) + '.png');
      } else {
        await Exporters.zipBlobs(blobs.map(function (b, i) { return { name: baseName(f) + '_' + (i + 1) + '.png', blob: b }; }), baseName(f) + '_PNG.zip');
      }
      toast('PNG ' + blobs.length + '장 저장 완료', 'ok');
    } catch (e) { console.error(e); toast('PNG 실패: ' + (e.message || ''), 'err'); }
    finally { busy(false); }
  }

  // ---- 텍스트/마크다운 추출 -----------------------------------------
  async function doMarkdown(copy) {
    var f = currentFile(); if (!f) return;
    if (!window.Exporters) { toast('라이브러리를 불러오지 못했어요', 'err'); return; }
    try {
      var md = Exporters.sheetToMarkdown(els.sheet) || '';
      if (copy) {
        var ok = await Exporters.copyText(md);
        toast(ok ? '마크다운 복사됨 (' + md.length + '자)' : '복사 실패', ok ? 'ok' : 'err');
      } else {
        Exporters.downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), baseName(f) + '.md');
        toast('마크다운(.md) 다운로드', 'ok');
      }
    } catch (e) { console.error(e); toast('마크다운 실패: ' + (e.message || ''), 'err'); }
  }

  // ---- 전체 PDF · ZIP ------------------------------------------------
  async function doZipAll() {
    var done = state.files.filter(function (x) { return (x.status === 'done' || x.status === 'warn') && x.rendered; });
    if (done.length < 2) return;
    if (!ensureLibs()) return;
    busy(true, '전체 PDF 생성 중…');
    try {
      var items = [];
      for (var i = 0; i < done.length; i++) {
        busy(true, '전체 PDF 생성 중… (' + (i + 1) + '/' + done.length + ')');
        var canvas = await fileToCanvas(done[i], 2);
        items.push({ name: baseName(done[i]) + '.pdf', blob: Exporters.canvasToPdfBlob(canvas, done[i].rendered.meta) });
      }
      await Exporters.zipBlobs(items, '변환문서_' + done.length + '개.zip');
      toast(done.length + '개 PDF · ZIP 다운로드 완료', 'ok');
    } catch (e) { console.error(e); toast('ZIP 실패: ' + (e.message || ''), 'err'); }
    finally { busy(false); }
  }

  // ---- 다크 모드 ----------------------------------------------------
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('hwp2pdf-theme'); } catch (e) {}
    if (saved === 'dark' || (saved == null && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
    syncThemeIcon();
  }
  function toggleTheme() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('hwp2pdf-theme', dark ? 'light' : 'dark'); } catch (e) {}
    syncThemeIcon();
  }
  function syncThemeIcon() {
    els.themeToggle.textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
  }

  // ---- PWA 설치 -----------------------------------------------------
  var deferredPrompt = null;
  function initInstall() {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault(); deferredPrompt = e; els.installBtn.hidden = false;
    });
    els.installBtn.addEventListener('click', async function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) {}
      deferredPrompt = null; els.installBtn.hidden = true;
    });
    window.addEventListener('appinstalled', function () { els.installBtn.hidden = true; });
  }

  // ---- 유틸 ----------------------------------------------------------
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function round(n) { return Math.round(n * 100) / 100; }
  var toastTimer;
  function toast(msg, kind, ms) {
    els.toast.textContent = msg; els.toast.className = 'toast' + (kind ? ' ' + kind : ''); els.toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { els.toast.hidden = true; }, ms || 2400);
  }
  function busy(on, text) { els.busy.hidden = !on; if (text) els.busyText.textContent = text; }
  var legalReturnFocus = null;
  function closeLegal() {
    els.legalModal.hidden = true;
    if (legalReturnFocus && legalReturnFocus.focus) { try { legalReturnFocus.focus(); } catch (e) {} }
  }
})();
