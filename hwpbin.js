/* =====================================================================
 * hwpbin.js — 구형 바이너리 HWP(5.x, OLE/CFB) → HTML 렌더러
 *
 * .hwp = OLE 복합문서. 내부 스트림은 raw-deflate 압축 + 레코드(태그/레벨/크기).
 *   DocInfo : FACE_NAME(글꼴)·CHAR_SHAPE(글자모양)·PARA_SHAPE(문단모양)·BIN_DATA(그림)
 *   BodyText/SectionN : PARA_HEADER(문단) + PARA_TEXT + PARA_CHAR_SHAPE(런) + CTRL_HEADER(표/그림/수식)
 *
 * 핵심: 표 셀 문단은 LIST_HEADER 다음에 "형제"로 나열됨 → 레벨+커서 기반 재귀 파싱.
 * parseHwp(ctx) 순수함수 — ctx.find(name)->{content}, ctx.inflate(u8)->u8, ctx.image(name)->dataURL.
 * ===================================================================== */
(function (root) {
  'use strict';

  var T = { BIN_DATA:18, FACE_NAME:19, BORDER_FILL:20, CHAR_SHAPE:21, PARA_SHAPE:25,
            PARA_HEADER:66, PARA_TEXT:67, PARA_CHAR_SHAPE:68, PARA_LINE_SEG:69,
            CTRL_HEADER:71, LIST_HEADER:72, TABLE:77, SHAPE_COMPONENT:76, SHAPE_PICTURE:85, EQEDIT:88 };

  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function colorref(v){ var r=v&0xff,g=(v>>8)&0xff,b=(v>>16)&0xff; return '#'+[r,g,b].map(function(x){return ('0'+x.toString(16)).slice(-2);}).join(''); }
  var SANS='"Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif', SERIF='"Noto Serif KR",serif';
  function fontStack(face){ var f=String(face||'').replace(/["'<>;{}()]/g,''); var fb=/바탕|명조|Batang|Myungjo|Serif|함초롬바탕|궁서/i.test(f)?('"Noto Serif KR",'+SERIF):SANS; return (f?'"'+f+'",':'')+fb; }

  // ---- 레코드 ---------------------------------------------------------
  function records(bytes){
    var dv=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var out=[], p=0, n=bytes.length;
    while(p+4<=n){
      var h=dv.getUint32(p,true); p+=4;
      var tag=h&0x3ff, level=(h>>>10)&0x3ff, size=(h>>>20)&0xfff;
      if(size===0xfff){ size=dv.getUint32(p,true); p+=4; }
      if(p+size>n) size=n-p;
      out.push({tag:tag, level:level, start:p, len:size, bytes:bytes});
      p+=size;
    }
    return out;
  }
  function rdv(r){ return new DataView(r.bytes.buffer, r.bytes.byteOffset+r.start, r.len); }

  // ---- DocInfo --------------------------------------------------------
  function parseDocInfo(bytes){
    var recs=records(bytes), fonts=[], charShapes=[], paraShapes=[], binData=[];
    recs.forEach(function(r){
      var dv=rdv(r);
      if(r.tag===T.FACE_NAME){
        var len=dv.getUint16(1,true), name=''; for(var i=0;i<len;i++) name+=String.fromCharCode(dv.getUint16(3+i*2,true)); fonts.push(name);
      } else if(r.tag===T.CHAR_SHAPE && r.len>=56){
        var faceH=dv.getUint16(0,true), faceL=dv.getUint16(2,true), baseSize=dv.getInt32(42,true), prop=dv.getUint32(46,true), color=dv.getUint32(52,true);
        charShapes.push({ face:fonts[faceH]||'', faceLatin:fonts[faceL]||'', sizePt:baseSize/100,
          italic:!!(prop&0x1), bold:!!(prop&0x2), underline:((prop>>>2)&0x3)!==0, strike:((prop>>>18)&0x7)!==0,
          sup:!!(prop&0x8000), sub:!!(prop&0x10000), color:colorref(color) });
      } else if(r.tag===T.PARA_SHAPE && r.len>=4){
        var p1=dv.getUint32(0,true), a=(p1>>>2)&0x7;
        var ls = r.len>=28 ? dv.getInt32(24,true) : 160;       // 줄 간격(보통 %)
        paraShapes.push({
          align:['justify','left','right','center','justify','justify','left'][a]||'left',
          leftMargin: r.len>=8 ? dv.getInt32(4,true) : 0,       // HWPUNIT
          rightMargin: r.len>=12 ? dv.getInt32(8,true) : 0,
          indent: r.len>=16 ? dv.getInt32(12,true) : 0,
          prevSpacing: r.len>=20 ? dv.getInt32(16,true) : 0,
          nextSpacing: r.len>=24 ? dv.getInt32(20,true) : 0,
          lineHeight: (ls>=50 && ls<=500) ? (ls/100) : 1.6
        });
      } else if(r.tag===T.BIN_DATA){
        var bp=dv.getUint16(0,true), type=bp&0xf, off=2, id=0, fmt='';
        if((type===1||type===2) && r.len>=4){ id=dv.getUint16(off,true); off+=2; if(off+2<=r.len){ var fl=dv.getUint16(off,true); off+=2; for(var k=0;k<fl && off+k*2+2<=r.len;k++) fmt+=String.fromCharCode(dv.getUint16(off+k*2,true)); } }
        binData.push({type:type, id:id, fmt:fmt.toLowerCase()});
      }
    });
    return { fonts:fonts, charShapes:charShapes, paraShapes:paraShapes, binData:binData };
  }

  // ---- PARA_TEXT 디코드 ----------------------------------------------
  var EXT_CTRL={1:1,2:1,3:1,11:1,12:1,14:1,15:1,16:1,17:1,18:1,21:1,22:1,23:1};
  function decodeParaText(bytes){
    var dv=new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var segs=[], cur='', i=0, n=bytes.length;
    function flush(){ if(cur){ segs.push({t:'text', s:cur}); cur=''; } }
    while(i+2<=n){
      var w=dv.getUint16(i,true);
      if(w>=32){ cur+=String.fromCharCode(w); i+=2; continue; }
      if(EXT_CTRL[w]){ flush(); segs.push({t:'inline'}); i+=16; continue; }
      if(w===9){ flush(); segs.push({t:'tab'}); }
      else if(w===10){ flush(); segs.push({t:'lbreak'}); }
      i+=2;
    }
    flush(); return segs;
  }

  // ---- 커서 기반 본문 파싱 -------------------------------------------
  function parseBody(recs){
    var cur={i:0}, paras=[];
    while(cur.i<recs.length){
      if(recs[cur.i].tag===T.PARA_HEADER && recs[cur.i].level===0) paras.push(parsePara(recs,cur));
      else cur.i++;
    }
    return paras;
  }
  function parsePara(recs,cur){
    var ph=recs[cur.i], L=ph.level; cur.i++;
    var para={header:ph, text:null, cs:null, ctrls:[]};
    while(cur.i<recs.length && recs[cur.i].level>L){
      var r=recs[cur.i];
      if(r.level===L+1 && r.tag===T.PARA_TEXT){ para.text=r; cur.i++; }
      else if(r.level===L+1 && r.tag===T.PARA_CHAR_SHAPE){ para.cs=r; cur.i++; }
      else if(r.level===L+1 && r.tag===T.CTRL_HEADER){ para.ctrls.push(parseCtrl(recs,cur)); }
      else cur.i++;
    }
    return para;
  }
  function parseCtrl(recs,cur){
    var ch=recs[cur.i], L=ch.level; cur.i++;
    var ctrl={header:ch, table:null, lists:[], pic:null, eq:null};
    while(cur.i<recs.length && recs[cur.i].level>L){
      var r=recs[cur.i];
      if(r.level===L+1 && r.tag===T.TABLE){ ctrl.table=r; cur.i++; }
      else if(r.level===L+1 && r.tag===T.LIST_HEADER){
        var list={paras:[]}; cur.i++;
        while(cur.i<recs.length && recs[cur.i].level===L+1 && recs[cur.i].tag===T.PARA_HEADER) list.paras.push(parsePara(recs,cur));
        ctrl.lists.push(list);
      } else { if(r.tag===T.SHAPE_PICTURE) ctrl.pic=r; if(r.tag===T.EQEDIT) ctrl.eq=r; cur.i++; }
    }
    return ctrl;
  }

  // ---- 렌더 -----------------------------------------------------------
  function Renderer(doc, ctx){ this.doc=doc; this.ctx=ctx; this.binPtr=0; }

  Renderer.prototype.charCss=function(cs){
    if(!cs) cs={sizePt:10,color:'#000',face:''};
    var sz=cs.sizePt||10, css=['font-size:'+sz+'pt','font-family:'+fontStack(cs.face),'color:'+(cs.color||'#000')];
    if(cs.bold) css.push('font-weight:700'); if(cs.italic) css.push('font-style:italic');
    var dec=[]; if(cs.underline) dec.push('underline'); if(cs.strike) dec.push('line-through'); if(dec.length) css.push('text-decoration:'+dec.join(' '));
    if(cs.sup) css.push('vertical-align:super;font-size:'+(sz*0.74)+'pt'); if(cs.sub) css.push('vertical-align:sub;font-size:'+(sz*0.74)+'pt');
    return css.join(';');
  };
  Renderer.prototype.ctrlId=function(ctrl){ var dv=rdv(ctrl.header); if(ctrl.header.len<4) return ''; return String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3)); };

  Renderer.prototype.renderPara=function(para){
    var dv=rdv(para.header);
    var paraShapeId=para.header.len>=10?dv.getUint16(8,true):0;
    var charShapeCnt=para.header.len>=14?dv.getUint16(12,true):0;
    var ps=this.doc.paraShapes[paraShapeId]||{align:'left'};

    var csMap=[];
    if(para.cs){ var cdv=rdv(para.cs); for(var k=0;k<charShapeCnt && k*8+8<=para.cs.len;k++) csMap.push({pos:cdv.getUint32(k*8,true), id:cdv.getUint32(k*8+4,true)}); }
    function shapeAt(pos){ var id=0; for(var j=0;j<csMap.length;j++){ if(csMap[j].pos<=pos) id=csMap[j].id; else break; } return id; }

    var segs=para.text?decodeParaText(new Uint8Array(para.text.bytes.buffer, para.text.bytes.byteOffset+para.text.start, para.text.len)):[];

    // 렌더 가능한 컨트롤만 인라인 큐
    var self=this, objs=[];
    para.ctrls.forEach(function(c){ var id=self.ctrlId(c); if(id==='tbl '||id==='gso '||id==='$ce'||(c.eq))  objs.push(c); else if(c.lists.length||c.table||c.pic) objs.push(c); });

    var inner='', blocks='', pos=0, curId=-1, span='';
    function open(id){ return '<span style="'+self.charCss(self.doc.charShapes[id])+'">'; }
    function closeSpan(){ if(span){ inner+=span+'</span>'; span=''; curId=-1; } }
    for(var s=0;s<segs.length;s++){
      var seg=segs[s];
      if(seg.t==='text'){
        for(var ci=0;ci<seg.s.length;ci++){ var id=shapeAt(pos); if(id!==curId){ if(span) inner+=span+'</span>'; span=open(id); curId=id; } span+=esc(seg.s[ci]); pos++; }
      } else if(seg.t==='tab'){ closeSpan(); inner+='<span style="display:inline-block;min-width:2em"></span>'; pos+=1; }
      else if(seg.t==='lbreak'){ closeSpan(); inner+='<br>'; pos+=1; }
      else if(seg.t==='inline'){ closeSpan(); if(objs.length){ var r=self.renderCtrl(objs.shift()); inner+=r.inline; blocks+=r.block; } pos+=8; }
    }
    if(span) inner+=span+'</span>';
    objs.forEach(function(o){ var r=self.renderCtrl(o); inner+=r.inline; blocks+=r.block; });

    var mm=function(u){ return (u||0)*25.4/7200; };
    var css='text-align:'+(ps.align||'left');
    if(ps.lineHeight) css+=';line-height:'+ps.lineHeight;
    if(ps.leftMargin>0) css+=';padding-left:'+mm(ps.leftMargin).toFixed(2)+'mm';
    if(ps.rightMargin>0) css+=';padding-right:'+mm(ps.rightMargin).toFixed(2)+'mm';
    if(ps.indent) css+=';text-indent:'+mm(ps.indent).toFixed(2)+'mm';
    if(ps.prevSpacing>0) css+=';margin-top:'+mm(ps.prevSpacing).toFixed(2)+'mm';
    if(ps.nextSpacing>0) css+=';margin-bottom:'+mm(ps.nextSpacing).toFixed(2)+'mm';
    return '<p class="hp-para" style="'+css+'">'+(inner||'&#8203;')+'</p>'+blocks;
  };

  Renderer.prototype.renderCtrl=function(ctrl){
    var id=this.ctrlId(ctrl);
    if(id==='tbl '||ctrl.table) return { inline:'', block:this.renderTable(ctrl) };
    if(ctrl.eq) return { inline:this.renderEq(ctrl), block:'' };
    if(ctrl.pic || id==='gso ') return { inline:this.renderGso(ctrl), block:(ctrl.lists.length?this.renderBoxText(ctrl):'') };
    if(ctrl.lists.length) return { inline:'', block:this.renderBoxText(ctrl) };
    return { inline:'', block:'' };
  };

  Renderer.prototype.renderTable=function(ctrl){
    var self=this, nRows=1, nCols=1;
    if(ctrl.table){ var dv=rdv(ctrl.table); nRows=dv.getUint16(4,true)||1; nCols=dv.getUint16(6,true)||1; }
    var cells=ctrl.lists, idx=0, html='<table class="hp-tbl"><tbody>';
    var rows=Math.max(nRows, Math.ceil(cells.length/Math.max(1,nCols)));
    for(var r=0;r<rows;r++){
      html+='<tr>';
      for(var c=0;c<nCols && idx<cells.length;c++){
        var inner=''; cells[idx++].paras.forEach(function(p){ try{ inner+=self.renderPara(p); }catch(e){} });
        html+='<td>'+(inner||'&#8203;')+'</td>';
      }
      html+='</tr>';
    }
    return html+'</tbody></table>';
  };
  Renderer.prototype.renderBoxText=function(ctrl){
    var self=this, inner='';
    ctrl.lists.forEach(function(l){ l.paras.forEach(function(p){ try{ inner+=self.renderPara(p); }catch(e){} }); });
    return inner?('<div class="hp-textbox" style="border:0.2mm solid #999;padding:1mm 1.5mm;margin:1mm 0">'+inner+'</div>'):'';
  };
  Renderer.prototype.renderGso=function(ctrl){
    var url=null;
    if(ctrl.pic){ var id=this.picBinId(ctrl.pic); url=this.imgById(id); }
    if(!url) url=this.nextImg();
    return url?('<img class="hp-img" style="max-width:100%" src="'+url+'" alt="" />'):'';
  };
  Renderer.prototype.picBinId=function(pic){ var dv=rdv(pic); for(var off=pic.len-2;off>=0;off-=2){ var v=dv.getUint16(off,true); if(v>0&&v<2000) return v; } return null; };
  Renderer.prototype.imgById=function(id){ if(id==null) return null; var fmt='png',bd=this.doc.binData; for(var i=0;i<bd.length;i++){ if(bd[i].id===id){ fmt=bd[i].fmt||'png'; break; } } return this.ctx.image('BIN'+('0000'+id.toString(16).toUpperCase()).slice(-4)+'.'+fmt); };
  Renderer.prototype.nextImg=function(){ var names=this.ctx.binNames?this.ctx.binNames():[]; while(this.binPtr<names.length){ var u=this.ctx.image(names[this.binPtr++]); if(u) return u; } return null; };
  Renderer.prototype.renderEq=function(ctrl){
    var script=''; if(ctrl.eq){ var dv=rdv(ctrl.eq); try{ var len=dv.getUint16(0,true); for(var i=0;i<len && 2+i*2+2<=ctrl.eq.len;i++) script+=String.fromCharCode(dv.getUint16(2+i*2,true)); }catch(e){} }
    if(!script.trim()) return '';
    return '<span class="hp-eq">'+(root.HWPEqn?root.HWPEqn.render(script,false):esc(script))+'</span>';
  };

  // PAGE_DEF(73): 용지 크기·여백 → meta
  function applyPageDef(meta, r){
    if(r.len<24) return;
    var dv=rdv(r), mm=function(u){ return u*25.4/7200; };
    var w=mm(dv.getUint32(0,true)>>>0), h=mm(dv.getUint32(4,true)>>>0);
    if(w>=50 && w<=2000 && h>=50 && h<=2000){ meta.page={ wMm:w, hMm:h, landscape:w>h }; }
    var l=mm(dv.getUint32(8,true)>>>0), rt=mm(dv.getUint32(12,true)>>>0), t=mm(dv.getUint32(16,true)>>>0), b=mm(dv.getUint32(20,true)>>>0);
    if(l>=0&&l<200&&rt>=0&&rt<200&&t>=0&&t<200&&b>=0&&b<200){ meta.margin={ t:t, r:rt, b:b, l:l }; }
  }

  // ---- 메인(순수) ----------------------------------------------------
  function parseHwp(ctx){
    var fh=ctx.find('FileHeader'); if(!fh) throw new Error('FileHeader 없음 — HWP 가 아님');
    var fhb=fh.content, sig=''; for(var i=0;i<16;i++) sig+=String.fromCharCode(fhb[i]||0);
    if(sig.indexOf('HWP Document')<0) throw new Error('HWP 시그니처가 아닙니다');
    var flags=(fhb[36]||0)|((fhb[37]||0)<<8)|((fhb[38]||0)<<16)|((fhb[39]||0)<<24);
    var compressed=!!(flags&1);
    if(flags&2) throw new Error('암호가 걸린 .hwp 는 변환할 수 없어요');

    function stream(name){ var s=ctx.find(name); if(!s) return null; var u8=s.content.constructor===Uint8Array?s.content:new Uint8Array(s.content); return compressed?ctx.inflate(u8):u8; }

    var diBytes=stream('DocInfo'); if(!diBytes) throw new Error('DocInfo 없음');
    var doc=parseDocInfo(diBytes);
    var rend=new Renderer(doc, ctx);

    var meta={ page:{wMm:210,hMm:297,landscape:false}, margin:{t:20,r:20,b:20,l:20} };
    var bodyHtml='', s=0, paraTotal=0;
    while(s<300){
      var sb=stream('BodyText/Section'+s); if(!sb) break;
      var recs=records(sb);
      if(s===0){ for(var pi=0;pi<recs.length;pi++){ if(recs[pi].tag===73){ applyPageDef(meta, recs[pi]); break; } } }
      if(s>0) bodyHtml+='<div class="hp-pagebreak" style="break-before:page"></div>';
      var paras=parseBody(recs); paraTotal+=paras.length;
      for(var p=0;p<paras.length;p++){ try{ bodyHtml+=rend.renderPara(paras[p]); }catch(e){} }
      s++;
    }
    if(s===0) throw new Error('BodyText 섹션이 없습니다');
    return { html:bodyHtml, meta:meta,
             stats:{ sections:s, paras:paraTotal, fonts:doc.fonts.length, charShapes:doc.charShapes.length } };
  }

  // ---- 브라우저 진입점 ------------------------------------------------
  function loadScript(src){ return new Promise(function(res,rej){ var sc=document.createElement('script'); sc.src=src; sc.onload=res; sc.onerror=rej; document.head.appendChild(sc); }); }
  function bytesToB64(b){ var s='',CH=0x8000; for(var i=0;i<b.length;i+=CH) s+=String.fromCharCode.apply(null,Array.prototype.slice.call(b,i,i+CH)); return btoa(s); }

  function rawImg(fe, name){
    var e=fe(name); if(!e||!e.content||e.content.length<4) return null;
    var b=e.content.constructor===Uint8Array?e.content:new Uint8Array(e.content);
    if(!(b[0]===0x89||b[0]===0xff||b[0]===0x47||(b[0]===0x42&&b[1]===0x4d))){ try{ b=root.pako.inflateRaw(b); }catch(e2){} }
    var ext=(name.split('.').pop()||'png').toLowerCase();
    var mime=({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp'})[ext]||'image/png';
    return { bytes:b, mime:mime };
  }
  // 큰 이미지는 디코드 후 축소(최대 1600px) → JPEG 로 임베드. 작은 건 원본 그대로.
  async function imgToDataUrl(raw){
    if(!raw) return '';
    if(raw.bytes.length<=700000) return 'data:'+raw.mime+';base64,'+bytesToB64(raw.bytes);
    try{
      var blob=new Blob([raw.bytes],{type:raw.mime}), u=URL.createObjectURL(blob);
      var img=await new Promise(function(res,rej){ var im=new Image(); im.onload=function(){res(im);}; im.onerror=rej; im.src=u; });
      var MAX=1600, sc=Math.min(1, MAX/Math.max(img.width||1, img.height||1));
      var w=Math.max(1,Math.round((img.width||1)*sc)), h=Math.max(1,Math.round((img.height||1)*sc));
      var cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      URL.revokeObjectURL(u);
      return cv.toDataURL('image/jpeg',0.82);
    }catch(e){ return 'data:'+raw.mime+';base64,'+bytesToB64(raw.bytes); }
  }

  async function parse(arrayBuffer){
    var CFB=await import('https://esm.sh/cfb@1.2.2');
    var read=CFB.read||(CFB.default&&CFB.default.read), find=CFB.find||(CFB.default&&CFB.default.find);
    if(typeof root.pako==='undefined') await loadScript('https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako_inflate.min.js');
    var cfb=read(new Uint8Array(arrayBuffer),{type:'array'});
    function fe(name){ return find(cfb,name)||find(cfb,'/'+name)||find(cfb,'BinData/'+name)||find(cfb,'/BinData/'+name); }
    var tokenMap={}, tokSeq=0;
    var ctx={
      find:function(name){ var e=fe(name); return e&&e.content?{content:(e.content.constructor===Uint8Array?e.content:new Uint8Array(e.content))}:null; },
      inflate:function(u8){ return root.pako.inflateRaw(u8); },
      image:function(name){ if(!rawImg(fe,name)) return null; var tok='IMG'+(tokSeq++)+''; tokenMap[tok]=name; return tok; },
      binNames:function(){ var names=[]; (cfb.FullPaths||[]).forEach(function(p){ var m=p.match(/BinData\/([^\/]+)$/i); if(m) names.push(m[1]); }); return names; }
    };
    var res=parseHwp(ctx);
    // 이미지 토큰 → 데이터URL (큰 그림 축소). 같은 이미지는 한 번만.
    var html=res.html, cache={}, toks=Object.keys(tokenMap);
    for(var i=0;i<toks.length;i++){
      var name=tokenMap[toks[i]];
      if(!(name in cache)) cache[name]=await imgToDataUrl(rawImg(fe,name));
      html=html.split(toks[i]).join(cache[name]||'');
    }
    res.html=html;
    return res;
  }

  root.HWPBIN={ parse:parse, parseHwp:parseHwp, _parseDocInfo:parseDocInfo, _records:records };
})(typeof window!=='undefined'?window:globalThis);
