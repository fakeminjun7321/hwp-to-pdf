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
      openLegal: $('#openLegal'), closeLegal: $('#closeLegal'), legalModal: $('#legalModal')
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

    // 법적 고지 모달
    els.openLegal.addEventListener('click', function () { els.legalModal.hidden = false; });
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
      if (ext !== 'hwp' && ext !== 'hwpx') { toast('지원하지 않는 형식: ' + file.name, 'err'); return; }
      var reader = new FileReader();
      reader.onload = function () { addBuffer(reader.result, file.name); };
      reader.readAsArrayBuffer(file);
    });
  }

  function addBuffer(arrayBuffer, name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var f = { id: ++uid, name: name, ext: ext, buf: arrayBuffer, status: 'pending', rendered: null, error: null };
    state.files.push(f);
    els.queueWrap.hidden = false;
    renderQueue();
    return processFile(f);
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
        '<span class="ficon ' + f.ext + '">' + f.ext.toUpperCase() + '</span>' +
        '<span class="fmeta"><span class="fname">' + escapeHtml(f.name) + '</span>' +
        '<span class="fstat ' + statCls + '">' + statTxt + (f.error ? ' · ' + escapeHtml(f.error) : '') + '</span></span>' +
        spinner +
        '<button class="fx" title="제거">×</button>';
      li.querySelector('.fx').onclick = function (e) { e.stopPropagation(); removeFile(f); };
      els.queue.appendChild(li);
    });
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
      if (f.ext === 'hwpx') {
        f.rendered = await window.HWPX.parse(f.buf.slice(0));
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
    var CFB = await import('https://esm.sh/cfb@1.2.2');
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

    var banner = '<div class="fb-banner">⚠️ 구형 <b>.hwp</b> 형식은 한글이 저장해 둔 <b>첫 페이지 미리보기</b>로 표시됩니다. ' +
      '표·서식·여러 페이지까지 <b>정밀하게</b> 변환하려면 한글에서 <b>다른 이름으로 저장 → 한/글 문서(*.hwpx)</b> 로 저장한 뒤 다시 올려 주세요.</div>';

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

  // ---- PDF: 이미지(즉시 다운로드) -----------------------------------
  async function doImagePdf() {
    if (state.current == null) return;
    var f = state.files.find(function (x) { return x.id === state.current; });
    if (!f) return;
    if (typeof html2canvas === 'undefined' || !window.jspdf) { toast('PDF 라이브러리 로드 실패', 'err'); return; }

    busy(true, '이미지 PDF 생성 중…');
    var z = state.zoom; els.sheet.style.transform = 'none';
    try {
      var m = f.rendered.meta, pg = m.page;
      var canvas = await html2canvas(els.sheet, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
      var imgData = canvas.toDataURL('image/jpeg', 0.92);
      var jsPDF = window.jspdf.jsPDF;
      var orient = pg.wMm > pg.hMm ? 'landscape' : 'portrait';
      var pdf = new jsPDF({ unit: 'mm', format: [pg.wMm, pg.hMm], orientation: orient });
      var imgWmm = pg.wMm;
      var imgHmm = canvas.height * pg.wMm / canvas.width;
      var pageHmm = pg.hMm;
      var pages = Math.max(1, Math.ceil(imgHmm / pageHmm - 0.001));
      for (var i = 0; i < pages; i++) {
        if (i > 0) pdf.addPage([pg.wMm, pg.hMm], orient);
        pdf.addImage(imgData, 'JPEG', 0, -i * pageHmm, imgWmm, imgHmm, undefined, 'FAST');
      }
      pdf.save(f.name.replace(/\.(hwp|hwpx)$/i, '') + '.pdf');
      toast('PDF 다운로드 완료', 'ok');
    } catch (e) {
      console.error(e); toast('이미지 PDF 실패: ' + (e.message || ''), 'err');
    } finally {
      els.sheet.style.transform = 'scale(' + z + ')';
      busy(false);
    }
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
  function closeLegal() { els.legalModal.hidden = true; }
})();
