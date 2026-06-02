/* =====================================================================
 * hwpx.js — HWPX(OWPML) → HTML 렌더러  (브라우저 전용, 외부 의존: JSZip)
 *
 * .hwpx 는 ZIP 컨테이너:
 *   Contents/header.xml     글꼴 / 글자모양(charPr) / 문단모양(paraPr) / 스타일 / 테두리
 *   Contents/section0.xml…  본문 (문단 hp:p > 글상자 hp:run > 글자 hp:t, 표, 그림, 수식)
 *   Contents/content.hpf    매니페스트 (그림 등 BinData 매핑)
 *   BinData/…               내장 이미지
 *
 * 단위: HWPUNIT = 1/7200 인치.  글자 height = 1/100 pt.
 * ===================================================================== */
(function (root) {
  'use strict';

  var HWPUNIT_PER_INCH = 7200, MM_PER_INCH = 25.4;
  function u2mm(u){ return (Number(u)||0) / HWPUNIT_PER_INCH * MM_PER_INCH; }
  function u2px(u){ return (Number(u)||0) / HWPUNIT_PER_INCH * 96; }

  // ---- DOM 헬퍼 (네임스페이스 prefix 그대로 매칭) ---------------------
  function attr(el, name, def){ var v = el && el.getAttribute ? el.getAttribute(name) : null; return v==null?def:v; }
  function tags(parent, name){ return parent ? Array.prototype.slice.call(parent.getElementsByTagName(name)) : []; }
  function tag(parent, name){ var l = parent ? parent.getElementsByTagName(name) : null; return l && l.length ? l[0] : null; }
  function elementChildren(el){
    var out = []; if(!el) return out;
    for(var n = el.firstChild; n; n = n.nextSibling){ if(n.nodeType === 1) out.push(n); }
    return out;
  }
  function localName(el){ return el.localName || (el.nodeName.indexOf(':')>=0 ? el.nodeName.split(':')[1] : el.nodeName); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }

  var SANS = '"Apple SD Gothic Neo","Malgun Gothic","맑은 고딕",sans-serif';
  var SERIF = '"Noto Serif KR",serif';
  var SANS_KR = '"Noto Sans KR",'+SANS;
  function isSerifFace(face){ return /바탕|명조|Batang|Myungjo|Serif|함초롬바탕|궁서|Gungsuh/i.test(face||''); }

  // =====================================================================
  function Parser(zip){
    this.zip = zip;
    this.fontfaces = {};   // lang -> [face,...]
    this.charPr = {};      // id -> charProps
    this.paraPr = {};      // id -> paraProps
    this.styles = {};      // id -> {name,paraPrId,charPrId}
    this.borderFills = {}; // id -> {borders, bg}
    this.bin = {};         // binaryItemIDRef -> dataURL  (async filled)
    this.meta = { title:'', page:{wMm:210,hMm:297,landscape:false}, margin:{t:20,r:20,b:20,l:20} };
  }

  Parser.prototype.text = async function(path){
    var f = this.zip.file(path); return f ? await f.async('string') : null;
  };
  Parser.prototype.xml = async function(path){
    var s = await this.text(path); if(!s) return null;
    return new DOMParser().parseFromString(s, 'application/xml');
  };

  // ---- 헤더 파싱 -----------------------------------------------------
  Parser.prototype.parseHeader = async function(){
    var doc = await this.xml('Contents/header.xml');
    if(!doc) return;

    // 글꼴: lang 별 id->face
    tags(doc, 'hh:fontface').forEach(function(ff){
      var lang = attr(ff,'lang','HANGUL');
      var arr = this.fontfaces[lang] = this.fontfaces[lang] || [];
      tags(ff, 'hh:font').forEach(function(fn){
        arr[parseInt(attr(fn,'id','0'),10)] = attr(fn,'face','');
      });
    }, this);

    // 글자모양
    tags(doc, 'hh:charPr').forEach(function(cp){
      var id = attr(cp,'id');
      var fr = tag(cp,'hh:fontRef');
      var ul = tag(cp,'hh:underline');
      var so = tag(cp,'hh:strikeout');
      var color = attr(cp,'textColor','#000000');
      var props = {
        sizePt: (parseFloat(attr(cp,'height','1000'))||1000)/100,
        color: (color && color.toLowerCase()!=='none') ? color : '#000000',
        bold: !!tag(cp,'hh:bold'),
        italic: !!tag(cp,'hh:italic'),
        underline: ul ? (attr(ul,'type','NONE')!=='NONE') : false,
        strike: so ? (attr(so,'shape','NONE')!=='NONE') : false,
        sup: !!tag(cp,'hh:supscript'),
        sub: !!tag(cp,'hh:subscript'),
        font: this.fontStack(fr)
      };
      this.charPr[id] = props;
    }, this);

    // 문단모양
    tags(doc, 'hh:paraPr').forEach(function(pp){
      var al = tag(pp,'hh:align');
      var ls = tag(pp,'hh:lineSpacing');
      var mg = tag(pp,'hh:margin');
      function mv(node, child){ var c = node?tag(node,child):null; return c?parseFloat(attr(c,'value','0')):0; }
      var props = {
        align: this.mapAlign(al ? attr(al,'horizontal','LEFT') : 'LEFT'),
        lineType: ls ? attr(ls,'type','PERCENT') : 'PERCENT',
        lineValue: ls ? parseFloat(attr(ls,'value','160')) : 160,
        mLeft: u2mm(mv(mg,'hc:left')),
        mRight: u2mm(mv(mg,'hc:right')),
        indent: u2mm(mv(mg,'hc:intent')),
        spaceBefore: u2mm(mv(mg,'hc:prev')),
        spaceAfter: u2mm(mv(mg,'hc:next'))
      };
      this.paraPr[attr(pp,'id')] = props;
    }, this);

    // 스타일
    tags(doc, 'hh:style').forEach(function(st){
      this.styles[attr(st,'id')] = {
        name: attr(st,'name',''),
        paraPrId: attr(st,'paraPrIDRef'),
        charPrId: attr(st,'charPrIDRef')
      };
    }, this);

    // 테두리/채우기
    tags(doc, 'hh:borderFill').forEach(function(bf){
      function side(name){
        var b = tag(bf, name); if(!b) return null;
        var type = attr(b,'type','NONE');
        if(type==='NONE') return null;
        var w = parseFloat(attr(b,'width','0.1')) || 0.12;
        var c = attr(b,'color','#000000');
        var style = (type==='DOT'||type==='DASH')?'dashed':(type==='DOUBLE')?'double':'solid';
        return w.toFixed(2)+'mm '+style+' '+c;
      }
      var brush = tag(bf,'hc:winBrush');
      var bg = brush ? attr(brush,'faceColor','none') : 'none';
      this.borderFills[attr(bf,'id')] = {
        t: side('hh:topBorder'), r: side('hh:rightBorder'),
        b: side('hh:bottomBorder'), l: side('hh:leftBorder'),
        bg: (bg && bg.toLowerCase()!=='none') ? bg : null
      };
    }, this);
  };

  Parser.prototype.mapAlign = function(h){
    switch((h||'').toUpperCase()){
      case 'CENTER': return 'center';
      case 'RIGHT': return 'right';
      case 'JUSTIFY': case 'JUSTIFY_LOW': return 'justify';
      case 'DISTRIBUTE': case 'DISTRIBUTE_SPACE': return 'justify';
      default: return 'left';
    }
  };

  Parser.prototype.fontStack = function(fontRef){
    if(!fontRef) return SANS_KR;
    var hangul = (this.fontfaces.HANGUL||[])[parseInt(attr(fontRef,'hangul','0'),10)] || '';
    var latin  = (this.fontfaces.LATIN ||[])[parseInt(attr(fontRef,'latin','0'),10)] || '';
    var hanja  = (this.fontfaces.HANJA ||[])[parseInt(attr(fontRef,'hanja','0'),10)] || '';
    var fb = isSerifFace(hangul) ? '"Noto Serif KR",'+SERIF+','+SANS : SANS_KR;
    var stack = [];
    [latin, hangul, hanja].forEach(function(f){ if(f && stack.indexOf(f)<0) stack.push(f); });
    var quoted = stack.map(function(f){ return '"'+f+'"'; }).join(',');
    return (quoted ? quoted+',' : '') + fb;
  };

  // ---- 이미지(BinData) 미리 로드 ------------------------------------
  Parser.prototype.loadBin = async function(){
    // content.hpf 매니페스트에서 id -> href 매핑
    var hpf = await this.xml('Contents/content.hpf');
    var map = {}; // id -> path
    if(hpf){
      tags(hpf,'opf:item').concat(tags(hpf,'item')).forEach(function(it){
        var id = attr(it,'id'); var href = attr(it,'href');
        if(id && href) map[id] = href.replace(/^\.\//,'');
      });
    }
    // BinData 폴더의 모든 파일도 이름 기반으로 매핑 (binaryItemIDRef 가 파일명일 때 대비)
    var jobs = [];
    Object.keys(this.zip.files).forEach(function(path){
      if(/^(BinData|Contents\/BinData)\//i.test(path) && !this.zip.files[path].dir){
        jobs.push(this.embed(path));
      }
    }, this);
    // 매니페스트 항목도 로드
    Object.keys(map).forEach(function(id){
      var p = map[id];
      if(this.zip.file(p)) jobs.push(this.embed(p, id));
    }, this);
    await Promise.all(jobs);
  };
  Parser.prototype.embed = async function(path, id){
    var f = this.zip.file(path); if(!f) return;
    var ext = (path.split('.').pop()||'').toLowerCase();
    var mime = ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',
                 bmp:'image/bmp',svg:'image/svg+xml',wmf:'image/wmf',emf:'image/emf'})[ext] || 'image/png';
    var b64 = await f.async('base64');
    var url = 'data:'+mime+';base64,'+b64;
    var base = path.split('/').pop();
    var nameNoExt = base.replace(/\.[^.]+$/,'');
    this.bin[base] = url; this.bin[nameNoExt] = url;
    if(id){ this.bin[id] = url; }
  };
  Parser.prototype.imgFor = function(ref){
    if(!ref) return null;
    return this.bin[ref] || this.bin[ref.replace(/\.[^.]+$/,'')] || null;
  };

  // ===================================================================
  // 본문 렌더링
  // ===================================================================
  Parser.prototype.renderSections = async function(){
    var files = Object.keys(this.zip.files)
      .filter(function(p){ return /^Contents\/section\d+\.xml$/i.test(p); })
      .sort(function(a,b){ return (parseInt(a.match(/(\d+)/)[1])-parseInt(b.match(/(\d+)/)[1])); });
    var htmlParts = [];
    for(var s=0; s<files.length; s++){
      var doc = await this.xml(files[s]);
      if(!doc) continue;
      var sec = doc.documentElement; // hs:sec
      if(s===0) this.readPageGeometry(sec);
      if(s>0) htmlParts.push('<div class="hp-pagebreak" style="break-before:page"></div>');
      var paras = elementChildren(sec).filter(function(e){ return localName(e)==='p'; });
      for(var i=0;i<paras.length;i++){
        try{ htmlParts.push(this.renderPara(paras[i])); }
        catch(e){ /* 한 문단 오류가 전체를 막지 않도록 */ }
      }
    }
    return htmlParts.join('');
  };

  Parser.prototype.readPageGeometry = function(sec){
    var pagePr = tag(sec,'hp:pagePr');
    var margin = tag(sec,'hp:margin');
    if(pagePr){
      var w = u2mm(attr(pagePr,'width','59528')), h = u2mm(attr(pagePr,'height','84186'));
      var land = (attr(pagePr,'landscape','')||'').toUpperCase()==='WIDELY' && false; // landscape 표기는 제본방향이라 무시
      this.meta.page = { wMm:w, hMm:h, landscape:(w>h) };
    }
    if(margin){
      this.meta.margin = {
        t:u2mm(attr(margin,'top','5668')), r:u2mm(attr(margin,'right','5668')),
        b:u2mm(attr(margin,'bottom','5668')), l:u2mm(attr(margin,'left','5668'))
      };
    }
  };

  // 효과적인 charPr/paraPr 해석 (run/p 의 IDRef → 없으면 style → 없으면 0)
  Parser.prototype.effCharPr = function(charPrId, styleId){
    if(charPrId!=null && this.charPr[charPrId]) return this.charPr[charPrId];
    var st = styleId!=null ? this.styles[styleId] : null;
    if(st && this.charPr[st.charPrId]) return this.charPr[st.charPrId];
    return this.charPr['0'] || {sizePt:10,color:'#000',font:SANS_KR};
  };
  Parser.prototype.effParaPr = function(paraPrId, styleId){
    if(paraPrId!=null && this.paraPr[paraPrId]) return this.paraPr[paraPrId];
    var st = styleId!=null ? this.styles[styleId] : null;
    if(st && this.paraPr[st.paraPrId]) return this.paraPr[st.paraPrId];
    return this.paraPr['0'] || {align:'left',lineType:'PERCENT',lineValue:160};
  };

  Parser.prototype.renderPara = function(p){
    var paraPrId = attr(p,'paraPrIDRef'), styleId = attr(p,'styleIDRef');
    var pp = this.effParaPr(paraPrId, styleId);
    var css = [];
    css.push('text-align:'+pp.align);
    if(pp.lineType==='PERCENT' && pp.lineValue) css.push('line-height:'+(pp.lineValue/100));
    if(pp.mLeft)  css.push('margin-left:'+pp.mLeft.toFixed(2)+'mm');
    if(pp.mRight) css.push('margin-right:'+pp.mRight.toFixed(2)+'mm');
    if(pp.indent) css.push('text-indent:'+pp.indent.toFixed(2)+'mm');
    if(pp.spaceBefore) css.push('margin-top:'+pp.spaceBefore.toFixed(2)+'mm');
    if(pp.spaceAfter)  css.push('margin-bottom:'+pp.spaceAfter.toFixed(2)+'mm');

    var inner = '', blocks = '';
    var kids = elementChildren(p);
    for(var i=0;i<kids.length;i++){
      var k = kids[i], ln = localName(k);
      if(ln==='run'){
        var r = this.renderRun(k, styleId);
        inner += r.inline; blocks += r.block;
      }
      // linesegarray, ctrl(문단 레벨) 등은 무시
    }
    var paraHtml = '<p class="hp-para" style="'+css.join(';')+'">'+ (inner || '&#8203;') +'</p>';
    return paraHtml + blocks; // 표/그림 블록은 문단 뒤에
  };

  Parser.prototype.charCss = function(cp){
    var css = ['font-size:'+cp.sizePt+'pt','font-family:'+cp.font,'color:'+cp.color];
    if(cp.bold) css.push('font-weight:700');
    if(cp.italic) css.push('font-style:italic');
    var deco = [];
    if(cp.underline) deco.push('underline');
    if(cp.strike) deco.push('line-through');
    if(deco.length) css.push('text-decoration:'+deco.join(' '));
    if(cp.sup) css.push('vertical-align:super;font-size:'+(cp.sizePt*0.75)+'pt');
    if(cp.sub) css.push('vertical-align:sub;font-size:'+(cp.sizePt*0.75)+'pt');
    return css.join(';');
  };

  // run → { inline:'<span>…', block:'…표/그림…' }
  Parser.prototype.renderRun = function(run, styleId){
    var cp = this.effCharPr(attr(run,'charPrIDRef'), styleId);
    var style = this.charCss(cp);
    var inline = '', block = '';
    var kids = elementChildren(run);
    for(var i=0;i<kids.length;i++){
      var k = kids[i], ln = localName(k);
      if(ln==='t'){
        inline += '<span style="'+style+'">'+ this.renderText(k) +'</span>';
      } else if(ln==='equation'){
        inline += this.renderEquation(k);
      } else if(ln==='tbl'){
        block += this.renderTable(k);
      } else if(ln==='pic' || ln==='picture'){
        inline += this.renderPic(k);
      } else if(ln==='container' || ln==='rect' || ln==='ellipse' || ln==='line' || ln==='polygon' || ln==='curve' || ln==='drawText'){
        var img = tag(k,'hp:img') || tag(k,'hc:img');
        if(img) inline += this.renderPic(k);
      }
      // secPr, ctrl, footNote 등은 생략
    }
    return { inline:inline, block:block };
  };

  // hp:t 내부의 텍스트 + 인라인 요소(tab/lineBreak/nbSpace…)
  Parser.prototype.renderText = function(t){
    var out = '';
    for(var n = t.firstChild; n; n = n.nextSibling){
      if(n.nodeType === 3){ out += esc(n.nodeValue); }
      else if(n.nodeType === 1){
        var ln = localName(n);
        if(ln==='lineBreak') out += '<br>';
        else if(ln==='tab') out += '<span style="display:inline-block;min-width:2em"></span>';
        else if(ln==='nbSpace' || ln==='fwSpace') out += ' ';
        else if(ln==='hyphen') out += '-';
        else if(ln==='t') out += this.renderText(n); // 중첩 방지용
      }
    }
    return out;
  };

  Parser.prototype.renderEquation = function(eq){
    var sc = tag(eq,'hp:script');
    var script = sc ? (sc.textContent||'') : '';
    var disp = (attr(eq,'lineMode','CHAR')==='LINE');
    var html = (root.HWPEqn ? root.HWPEqn.render(script, disp) : esc(script));
    return '<span class="hp-eq">'+html+'</span>';
  };

  Parser.prototype.renderPic = function(pic){
    var img = tag(pic,'hp:img') || tag(pic,'hc:img');
    var ref = img ? (attr(img,'binaryItemIDRef') || attr(img,'href')) : null;
    var url = this.imgFor(ref);
    var sz = tag(pic,'hp:sz') || tag(pic,'hp:curSz') || tag(pic,'hp:orgSz');
    var wmm = sz ? u2mm(attr(sz,'width','0')) : 0;
    var hmm = sz ? u2mm(attr(sz,'height','0')) : 0;
    var dim = '';
    if(wmm) dim += 'width:'+wmm.toFixed(2)+'mm;';
    if(hmm) dim += 'height:'+hmm.toFixed(2)+'mm;';
    if(!url){
      return '<span class="hp-img-missing" style="display:inline-block;'+dim+'min-width:20mm;min-height:8mm;border:1px dashed #ccc;color:#aaa;font-size:9pt;text-align:center">［이미지］</span>';
    }
    return '<img class="hp-img" src="'+url+'" style="'+dim+'" alt="" />';
  };

  // 표
  Parser.prototype.renderTable = function(tbl){
    var rows = elementChildren(tbl).filter(function(e){ return localName(e)==='tr'; });
    // 열 너비: 첫 행의 cellSz width 합
    var colWidths = [];
    if(rows.length){
      elementChildren(rows[0]).filter(function(e){return localName(e)==='tc';}).forEach(function(tc){
        var cs = tag(tc,'hp:cellSz'); var span = tag(tc,'hp:cellSpan');
        var cspan = span?parseInt(attr(span,'colSpan','1'),10):1;
        var w = cs?u2mm(attr(cs,'width','0')):0;
        for(var j=0;j<cspan;j++) colWidths.push(w/cspan);
      });
    }
    var totalW = colWidths.reduce(function(a,b){return a+b;},0);
    var html = '<table class="hp-tbl" style="'+(totalW?('width:'+totalW.toFixed(1)+'mm;'):'')+'max-width:100%">';
    if(colWidths.length){
      html += '<colgroup>'+colWidths.map(function(w){return '<col style="width:'+w.toFixed(2)+'mm">';}).join('')+'</colgroup>';
    }
    rows.forEach(function(tr){
      html += '<tr>';
      elementChildren(tr).filter(function(e){return localName(e)==='tc';}).forEach(function(tc){
        html += this.renderCell(tc);
      }, this);
      html += '</tr>';
    }, this);
    html += '</table>';
    return html;
  };

  Parser.prototype.renderCell = function(tc){
    var span = tag(tc,'hp:cellSpan');
    var cspan = span?parseInt(attr(span,'colSpan','1'),10):1;
    var rspan = span?parseInt(attr(span,'rowSpan','1'),10):1;
    var bf = this.borderFills[attr(tc,'borderFillIDRef')];
    var css = [];
    if(bf){
      css.push('border-top:'+(bf.t||'0.12mm solid #bbb'));
      css.push('border-right:'+(bf.r||'0.12mm solid #bbb'));
      css.push('border-bottom:'+(bf.b||'0.12mm solid #bbb'));
      css.push('border-left:'+(bf.l||'0.12mm solid #bbb'));
      if(bf.bg) css.push('background:'+bf.bg);
    } else {
      css.push('border:0.12mm solid #bbb');
    }
    // 셀 안 문단들 (hp:subList > hp:p)
    var sub = tag(tc,'hp:subList');
    var content = '';
    if(sub){
      elementChildren(sub).filter(function(e){return localName(e)==='p';}).forEach(function(p){
        try{ content += this.renderPara(p); }catch(e){}
      }, this);
    }
    var spanAttr = (cspan>1?' colspan="'+cspan+'"':'') + (rspan>1?' rowspan="'+rspan+'"':'');
    return '<td'+spanAttr+' style="'+css.join(';')+'">'+(content||'&#8203;')+'</td>';
  };

  // ---- 메타: 제목 (PrvText 첫 줄 또는 문서 첫 문단) -------------------
  Parser.prototype.readTitle = async function(){
    var pv = await this.text('Preview/PrvText.txt');
    if(pv){ var line = pv.split(/\r?\n/).find(function(l){return l.trim();}); if(line) this.meta.title = line.trim().slice(0,80); }
  };

  // =====================================================================
  // 공개 API
  // =====================================================================
  async function parse(arrayBuffer){
    if(typeof JSZip === 'undefined') throw new Error('JSZip 가 로드되지 않았습니다.');
    var zip = await JSZip.loadAsync(arrayBuffer);
    var p = new Parser(zip);
    await p.parseHeader();
    await p.loadBin();
    await p.readTitle();
    var bodyHtml = await p.renderSections();
    return {
      html: bodyHtml,
      meta: p.meta
    };
  }

  root.HWPX = { parse: parse, _Parser: Parser };
})(typeof window !== 'undefined' ? window : globalThis);
