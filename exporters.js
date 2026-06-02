/* =====================================================================
 * exporters.js — 출력/내보내기 순수 헬퍼 모음 (window.Exporters)
 *
 * 이 모듈의 함수들은 "순수"합니다: 앱 상태(state)를 읽지 않고,
 * 호출자가 넘겨준 DOM 요소 / 데이터만 가지고 동작합니다.
 * 툴바 버튼 등에서 자유롭게 조합해 쓰도록 설계되었습니다.
 *
 * 외부 전역 의존 (index.html 에서 이미 로드됨):
 *   window.jspdf        (jsPDF UMD — .jsPDF 생성자)
 *   window.html2canvas  (DOM → canvas 래스터화)
 *   window.JSZip        (zip 묶음)
 * 없으면 명확한 Error 를 던집니다.
 * ===================================================================== */
(function (root) {
  'use strict';

  // ---- 전역 의존 가드 ------------------------------------------------
  function need(obj, name) {
    if (!obj) throw new Error(name + ' 가(이) 로드되지 않았습니다.');
    return obj;
  }
  function getJsPDF() {
    var ns = need(root.jspdf, 'jsPDF(window.jspdf)');
    return need(ns.jsPDF, 'jsPDF(window.jspdf.jsPDF)');
  }

  // ---- 시트 DOM → canvas --------------------------------------------
  // 호출자가 sheetEl 의 CSS transform(확대/축소) 을 미리 제거했다고 가정합니다.
  async function sheetToCanvas(sheetEl, scale) {
    var h2c = need(root.html2canvas, 'html2canvas');
    var s = (scale == null) ? 2 : scale;
    return await h2c(sheetEl, {
      scale: s,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false
    });
  }

  // ---- canvas → PDF Blob (여러 페이지 자동 분할) ---------------------
  function canvasToPdfBlob(canvas, pageMeta) {
    var JsPDF = getJsPDF();
    var pg = pageMeta.page;
    var orient = pg.wMm > pg.hMm ? 'landscape' : 'portrait';
    var doc = new JsPDF({ unit: 'mm', format: [pg.wMm, pg.hMm], orientation: orient });
    if (!canvas || !canvas.width || !canvas.height) return doc.output('blob');

    // 페이지별로 캔버스를 잘라 그 조각만 임베드 — 긴 문서에서 전체 이미지를
    // 페이지마다 중복 저장하던(파일·메모리 폭증) 문제를 막는다.
    var pageHpx = Math.max(1, Math.round(canvas.width * (pg.hMm / pg.wMm)));
    var pages = Math.max(1, Math.ceil(canvas.height / pageHpx));
    for (var i = 0; i < pages; i++) {
      var y = i * pageHpx;
      var sliceH = Math.min(pageHpx, canvas.height - y);
      if (sliceH <= 0) break;
      var tmp = document.createElement('canvas');
      tmp.width = canvas.width; tmp.height = sliceH;
      var ctx = tmp.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, tmp.width, tmp.height);
      ctx.drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
      var sliceData = tmp.toDataURL('image/jpeg', 0.92);
      var sliceHmm = sliceH * pg.wMm / canvas.width;
      if (i > 0) doc.addPage([pg.wMm, pg.hMm], orient);
      doc.addImage(sliceData, 'JPEG', 0, 0, pg.wMm, sliceHmm, undefined, 'FAST');
    }
    return doc.output('blob');
  }

  // ---- canvas → A4 페이지별 PNG Blob 배열 ----------------------------
  // 세로로 긴 캔버스를 한 페이지 높이(px)씩 잘라 각각 PNG 로 만듭니다.
  async function canvasToPngBlobs(canvas, pageMeta) {
    var pg = pageMeta.page;
    var pageHpx = Math.round(canvas.width * (pg.hMm / pg.wMm));
    if (pageHpx < 1) pageHpx = canvas.height || 1;

    var blobs = [];
    for (var y = 0; y < canvas.height; y += pageHpx) {
      var sliceH = Math.min(pageHpx, canvas.height - y);
      if (sliceH <= 0) break;
      var tmp = document.createElement('canvas');
      tmp.width = canvas.width;
      tmp.height = sliceH;
      var ctx = tmp.getContext('2d');
      // 흰 배경 (투명 영역이 검게 나오지 않도록)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tmp.width, tmp.height);
      ctx.drawImage(canvas, 0, y, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
      // eslint-disable-next-line no-loop-func
      var blob = await new Promise(function (res) { tmp.toBlob(res, 'image/png'); });
      if (blob) blobs.push(blob);
    }
    return blobs;
  }

  // ---- 여러 Blob 을 zip 으로 묶어 다운로드 ---------------------------
  // items: [{ name, blob }, ...]
  async function zipBlobs(items, zipName) {
    var JsZipCtor = need(root.JSZip, 'JSZip');
    var zip = new JsZipCtor();
    (items || []).forEach(function (it) {
      if (it && it.name && it.blob) zip.file(it.name, it.blob);
    });
    var out = await zip.generateAsync({ type: 'blob' });
    downloadBlob(out, zipName);
  }

  // ---- Blob 다운로드 (임시 <a download> 클릭) -----------------------
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // 클릭 직후 즉시 해제하면 일부 브라우저에서 다운로드가 끊겨 한 박자 뒤 해제
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---- 텍스트를 클립보드로 복사 (성공 여부 반환) --------------------
  async function copyText(text) {
    var str = String(text == null ? '' : text);
    try {
      if (root.navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(str);
        return true;
      }
    } catch (e) { /* 폴백으로 진행 */ }

    // 폴백: 숨긴 textarea + execCommand('copy')
    try {
      var ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  // ===================================================================
  // 렌더된 시트 DOM → Markdown
  // ===================================================================
  var BASELINE_PX = 13.3; // ≈ 10pt 기준선

  function escapePipes(s) {
    return String(s == null ? '' : s).replace(/\|/g, '\\|');
  }
  // 셀/한 줄용: 줄바꿈을 공백으로 접고 파이프 escape
  function cellText(el) {
    var t = (el && el.innerText != null) ? el.innerText : (el ? el.textContent : '');
    return escapePipes(String(t).replace(/\s*\n\s*/g, ' ').trim());
  }

  // 문단(p.hp-para) → Markdown 한 블록
  function paraToMd(el) {
    var txt = (el.innerText != null ? el.innerText : el.textContent || '');
    txt = String(txt).replace(/​/g, '').replace(/[ \t]+\n/g, '\n').trim();

    // 문단 안 수식: .hp-eq[data-latex] 가 있으면 $...$ 로 인라인 표기
    var eqs = el.querySelectorAll ? el.querySelectorAll('.hp-eq[data-latex]') : [];
    var inlineMath = [];
    for (var i = 0; i < eqs.length; i++) {
      var latex = eqs[i].getAttribute('data-latex');
      if (latex) {
        var tex = String(latex).trim();
        var eqTxt = (eqs[i].innerText != null ? eqs[i].innerText : eqs[i].textContent || '').trim();
        if (eqTxt && txt.indexOf(eqTxt) >= 0) {
          // 렌더 텍스트 자리에 $...$ 치환
          txt = txt.split(eqTxt).join('$' + tex + '$');
        } else {
          inlineMath.push('$' + tex + '$');
        }
      }
    }
    // 본문에 못 넣은 수식은 뒤에 덧붙임
    if (inlineMath.length) txt = (txt ? txt + ' ' : '') + inlineMath.join(' ');

    if (!txt) return '';

    // 제목 레벨 추정: 글자모양은 내부 <span> 에 있으므로 가장 큰 span 을 기준으로
    var fs = BASELINE_PX, fw = 400;
    try {
      var spans = el.querySelectorAll('span'), probe = el, maxfs = 0;
      for (var si = 0; si < spans.length; si++) {
        var f = parseFloat(root.getComputedStyle(spans[si]).fontSize) || 0;
        if (f > maxfs) { maxfs = f; probe = spans[si]; }
      }
      var cs = root.getComputedStyle(probe);
      fs = parseFloat(cs.fontSize) || BASELINE_PX;
      fw = parseInt(cs.fontWeight, 10) || 400;
    } catch (e) { /* getComputedStyle 불가 시 기본값 */ }

    var ratio = fs / BASELINE_PX;
    var prefix = '';
    if (ratio >= 1.7) prefix = '# ';
    else if (ratio >= 1.4) prefix = '## ';
    else if (ratio >= 1.2 || fw >= 700) prefix = '### ';

    return prefix + txt;
  }

  // table.hp-tbl → GitHub flavored Markdown 표
  function tableToMd(tbl) {
    var trs = tbl.querySelectorAll ? tbl.querySelectorAll('tr') : [];
    if (!trs.length) return '';
    var lines = [];
    var colCount = 0;

    for (var r = 0; r < trs.length; r++) {
      var cells = trs[r].querySelectorAll('th,td');
      var row = [];
      for (var c = 0; c < cells.length; c++) row.push(cellText(cells[c]));
      if (!row.length) continue;
      colCount = Math.max(colCount, row.length);
      lines.push('| ' + row.join(' | ') + ' |');

      if (lines.length === 1) {
        // 첫 행을 헤더로 보고 구분선 삽입
        var sep = [];
        for (var k = 0; k < row.length; k++) sep.push('---');
        lines.push('| ' + sep.join(' | ') + ' |');
      }
    }
    if (!lines.length) return '';
    return lines.join('\n');
  }

  // 독립 수식 블록 .hp-eq[data-latex] → $...$
  function eqBlockToMd(el) {
    var latex = el.getAttribute ? el.getAttribute('data-latex') : null;
    if (!latex) return '';
    return '$' + String(latex).trim() + '$';
  }

  // img → Markdown 이미지
  function imgToMd(el) {
    var src = el.getAttribute ? (el.getAttribute('src') || '') : '';
    if (!src) return '';
    if (src.indexOf('data:') === 0) return '![이미지]()';
    return '![](' + src + ')';
  }

  function sheetToMarkdown(sheetEl) {
    if (!sheetEl) return '';
    var blocks = [];
    var kids = sheetEl.children || [];

    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      try {
        var tag = (el.tagName || '').toLowerCase();
        var cls = el.classList;

        // docx-preview 등이 주입한 <style>/<script> 는 마크다운에 넣지 않는다
        if (tag === 'style' || tag === 'script' || tag === 'link' || tag === 'meta' || tag === 'noscript') continue;

        if (tag === 'p' && cls && cls.contains('hp-para')) {
          var md = paraToMd(el);
          if (md) blocks.push(md);

        } else if (tag === 'table' && cls && cls.contains('hp-tbl')) {
          var tmd = tableToMd(el);
          if (tmd) blocks.push(tmd);

        } else if (cls && cls.contains('hp-eq') && el.hasAttribute && el.hasAttribute('data-latex')) {
          var emd = eqBlockToMd(el);
          if (emd) blocks.push(emd);

        } else if (tag === 'img') {
          var imd = imgToMd(el);
          if (imd) blocks.push(imd);

        } else {
          // 알 수 없는 래퍼 컨테이너: 내부의 표/이미지/수식을 얕게 수습
          if (el.querySelector) {
            var innerTbl = el.querySelector('table.hp-tbl');
            if (innerTbl) {
              var itmd = tableToMd(innerTbl);
              if (itmd) blocks.push(itmd);
            } else {
              var innerImg = el.querySelector('img');
              if (innerImg) {
                var iimd = imgToMd(innerImg);
                if (iimd) blocks.push(iimd);
              } else {
                var txt = (el.innerText != null ? el.innerText : el.textContent || '');
                txt = String(txt).replace(/​/g, '').trim();
                if (txt) blocks.push(txt);
              }
            }
          }
        }
      } catch (e) {
        // 한 노드의 오류가 전체 변환을 막지 않도록
      }
    }

    var out = blocks.join('\n\n');
    // 빈 줄 3개 이상은 1개로 축약
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    return out;
  }

  // ===================================================================
  // 공개 API
  // ===================================================================
  root.Exporters = {
    sheetToCanvas: sheetToCanvas,
    canvasToPdfBlob: canvasToPdfBlob,
    canvasToPngBlobs: canvasToPngBlobs,
    zipBlobs: zipBlobs,
    downloadBlob: downloadBlob,
    copyText: copyText,
    sheetToMarkdown: sheetToMarkdown
  };
})(typeof window !== 'undefined' ? window : globalThis);
