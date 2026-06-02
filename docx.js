/* =====================================================================
 * docx.js — DOCX(OOXML) → HTML 렌더러  (브라우저 전용, 외부 의존: docx-preview, JSZip)
 *
 * .docx 는 ZIP 컨테이너(OOXML). 여기서는 직접 파싱하지 않고
 * docx-preview(https://github.com/VolodymyrBaydalka/docxjs) 가 만들어 주는
 * HTML 을 그대로 받아 기존 HWPX 파이프라인(window.HWPX.parse 와 동일한 모양)에
 * 끼워 넣는다.
 *
 * docx-preview 는 페이지 1장당 <section class="docx"> 요소를 emit 하며,
 * 그 인라인 style 에 Word 의 용지 크기(width / min-height)와 여백(padding)을
 * 담는다 (보통 pt, 가끔 px). 첫 섹션의 인라인 style 을 읽어 meta.page 를 만든다.
 *
 * 섹션의 padding(=여백)은 HTML 안에 그대로 둔 채로 반환하므로,
 * 호출부(app.js)에서 sheet padding 을 덧씌우지 않도록 meta.margin 은 0 으로 둔다.
 * ===================================================================== */
(function (root) {
  'use strict';

  var PT_PER_INCH = 72, PX_PER_INCH = 96, MM_PER_INCH = 25.4;

  // CSS 길이값("612pt", "816px", "210mm")을 mm 로 변환. 단위 접미사로 판별.
  function lenToMm(str) {
    if (str == null) return 0;
    var m = String(str).trim().match(/^(-?[\d.]+)\s*(pt|px|mm|cm|in)?$/i);
    if (!m) return 0;
    var v = parseFloat(m[1]); if (!isFinite(v)) return 0;
    var unit = (m[2] || 'px').toLowerCase();
    switch (unit) {
      case 'pt': return v / PT_PER_INCH * MM_PER_INCH;
      case 'px': return v / PX_PER_INCH * MM_PER_INCH;
      case 'cm': return v * 10;
      case 'in': return v * MM_PER_INCH;
      case 'mm': default: return v;
    }
  }

  // 첫 번째 docx 섹션의 인라인 style 에서 용지 크기를 뽑아 meta.page 를 만든다.
  function pageMetaFromSection(section) {
    var DEF = { wMm: 210, hMm: 297, landscape: false };
    if (!section || !section.style) return DEF;
    var st = section.style;
    // width / min-height(없으면 height) 가 Word 의 용지 폭·높이.
    var wMm = lenToMm(st.width);
    var hMm = lenToMm(st.minHeight) || lenToMm(st.height);
    if (!(wMm > 0) || !(hMm > 0)) return DEF;
    return { wMm: wMm, hMm: hMm, landscape: wMm > hMm };
  }

  // =====================================================================
  // 공개 API : window.HWPX.parse 와 동일한 모양
  // =====================================================================
  async function parse(arrayBuffer) {
    // 라이브러리 가드
    if (typeof root.docx === 'undefined') {
      throw new Error('docx-preview 가 로드되지 않았습니다');
    }
    try {
      // arrayBuffer → Blob
      var blob = new Blob([arrayBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      });

      // 화면에 붙이지 않은(detached) 컨테이너에 렌더
      var container = document.createElement('div');

      await root.docx.renderAsync(blob, container, null, {
        className: 'docx',
        inWrapper: false,        // 바깥 wrapper 없이 <section> 들만
        ignoreWidth: false,      // 용지 폭 유지
        ignoreHeight: false,     // 용지 높이 유지
        breakPages: true,        // 페이지별 <section> 분할
        useBase64URL: true,      // 이미지 base64 인라인 (서버 전송 없음)
        experimental: true       // 일부 추가 기능(탭 등) 활성화
      });

      // 첫 섹션의 인라인 style → 용지 크기
      var firstSection = container.querySelector('section.docx') || container.querySelector('section');
      var page = pageMetaFromSection(firstSection);

      // 섹션 padding 이 곧 여백이므로 호출부에서 다시 덧대지 않도록 0 으로.
      return {
        html: container.innerHTML,
        meta: {
          page: page,
          margin: { t: 0, r: 0, b: 0, l: 0 }
        },
        limited: false
      };
    } catch (e) {
      throw new Error('DOCX 변환 실패: ' + (e && e.message));
    }
  }

  root.DOCXX = { parse: parse };
})(typeof window !== 'undefined' ? window : globalThis);
