/* =====================================================================
 * hwpeqn.js — 한글(HWP) 수식 스크립트 → LaTeX 변환 + KaTeX 렌더
 *
 * 한글 수식은 LaTeX와 비슷하지만 다른 자체 문법을 씁니다:
 *   {A} over {B}            → \frac{A}{B}
 *   pmatrix{ a & b # c & d }→ \begin{pmatrix} a & b \\ c & d \end{pmatrix}
 *   x ^{2}  /  x _{i}       → x^{2} / x_{i}
 *   sqrt {x}                → \sqrt{x}
 *   bold E                  → \mathbf{E}
 *   `=`  `-`  `+`           → 백틱은 "공백/구분" 표시 → 제거
 *   gamma beta phi ...      → \gamma \beta \phi
 *   LEFT ( ... RIGHT )      → \left( ... \right)
 *   #  (행 구분)            → \\        &  (열/정렬)
 * ===================================================================== */
(function (root) {
  'use strict';

  // ---- 토큰 사전 -----------------------------------------------------
  var GREEK = {
    alpha:'\\alpha', beta:'\\beta', gamma:'\\gamma', delta:'\\delta',
    epsilon:'\\epsilon', varepsilon:'\\varepsilon', zeta:'\\zeta', eta:'\\eta',
    theta:'\\theta', vartheta:'\\vartheta', iota:'\\iota', kappa:'\\kappa',
    lambda:'\\lambda', mu:'\\mu', nu:'\\nu', xi:'\\xi', omicron:'o', pi:'\\pi',
    varpi:'\\varpi', rho:'\\rho', varrho:'\\varrho', sigma:'\\sigma',
    varsigma:'\\varsigma', tau:'\\tau', upsilon:'\\upsilon', phi:'\\phi',
    varphi:'\\varphi', chi:'\\chi', psi:'\\psi', omega:'\\omega'
  };
  // 대문자 형태가 있는 그리스 문자
  var GREEK_UPPER = {
    gamma:'\\Gamma', delta:'\\Delta', theta:'\\Theta', lambda:'\\Lambda',
    xi:'\\Xi', pi:'\\Pi', sigma:'\\Sigma', upsilon:'\\Upsilon',
    phi:'\\Phi', psi:'\\Psi', omega:'\\Omega'
  };
  var SYMBOL = {
    times:'\\times', cdot:'\\cdot', div:'\\div', ast:'\\ast', star:'\\star',
    circ:'\\circ', bullet:'\\bullet', pm:'\\pm', mp:'\\mp',
    leq:'\\leq', le:'\\leq', geq:'\\geq', ge:'\\geq', neq:'\\neq', ne:'\\neq',
    equiv:'\\equiv', approx:'\\approx', sim:'\\sim', simeq:'\\simeq',
    cong:'\\cong', propto:'\\propto', ll:'\\ll', gg:'\\gg',
    'in':'\\in', notin:'\\notin', ni:'\\ni', subset:'\\subset', supset:'\\supset',
    subseteq:'\\subseteq', supseteq:'\\supseteq', cup:'\\cup', cap:'\\cap',
    emptyset:'\\emptyset', forall:'\\forall', exists:'\\exists',
    partial:'\\partial', nabla:'\\nabla', infty:'\\infty', inf:'\\infty',
    rightarrow:'\\rightarrow', to:'\\to', leftarrow:'\\leftarrow',
    leftrightarrow:'\\leftrightarrow', Rightarrow:'\\Rightarrow',
    Leftarrow:'\\Leftarrow', Leftrightarrow:'\\Leftrightarrow',
    uparrow:'\\uparrow', downarrow:'\\downarrow', mapsto:'\\mapsto',
    sum:'\\sum', prod:'\\prod', int:'\\int', oint:'\\oint', iint:'\\iint',
    cdots:'\\cdots', ldots:'\\ldots', vdots:'\\vdots', ddots:'\\ddots',
    dots:'\\dots', angle:'\\angle', perp:'\\perp', parallel:'\\parallel',
    deg:'^{\\circ}', degree:'^{\\circ}', prime:"'", dprime:"''",
    cdotaxis:'\\cdots', therefore:'\\therefore', because:'\\because',
    Re:'\\Re', Im:'\\Im', hbar:'\\hbar', ell:'\\ell', wp:'\\wp',
    aleph:'\\aleph', langle:'\\langle', rangle:'\\rangle', vert:'|', dvert:'\\|'
  };
  // 함수 이름 (\operatorname 처리되는 것들)
  var FUNCS = ['sin','cos','tan','cot','sec','csc','sinh','cosh','tanh','coth',
    'log','ln','exp','lim','limsup','liminf','max','min','det','gcd','arg',
    'dim','ker','deg','hom','sup','arcsin','arccos','arctan'].reduce(function(o,f){o[f]='\\'+f;return o;},{});
  // 인자 하나를 먹는 접두 명령 (악센트/스타일)
  var PREFIX1 = {
    sqrt:'\\sqrt', bold:'\\mathbf', rm:'\\mathrm', it:'\\mathit', cal:'\\mathcal',
    bb:'\\mathbb', frak:'\\mathfrak', vec:'\\vec', hat:'\\hat', widehat:'\\widehat',
    bar:'\\bar', overline:'\\overline', underline:'\\underline', dot:'\\dot',
    ddot:'\\ddot', tilde:'\\tilde', widetilde:'\\widetilde', acute:'\\acute',
    grave:'\\grave', check:'\\check', breve:'\\breve', mathring:'\\mathring',
    underbrace:'\\underbrace', overbrace:'\\overbrace'
  };
  var MATRIX_ENV = {
    matrix:'matrix', pmatrix:'pmatrix', bmatrix:'bmatrix', Bmatrix:'Bmatrix',
    vmatrix:'vmatrix', Vmatrix:'Vmatrix', dmatrix:'vmatrix', cases:'cases'
  };
  var DELIM = {
    '(':'(', ')':')', '[':'[', ']':']', '|':'|', '.':'.',
    '{':'\\{', '}':'\\}', '<':'\\langle', '>':'\\rangle',
    'langle':'\\langle', 'rangle':'\\rangle', 'vert':'|', 'dvert':'\\|',
    'lfloor':'\\lfloor', 'rfloor':'\\rfloor', 'lceil':'\\lceil', 'rceil':'\\rceil'
  };

  function unescapeXml(s){
    return String(s).replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  }

  // ---- 토큰화 --------------------------------------------------------
  function tokenize(src){
    src = unescapeXml(src);
    src = src.replace(/`/g, ' ');               // 백틱 = 공백 표시
    // LEFT( / RIGHT) 처럼 구분자가 붙어 있으면 떼어낸다
    src = src.replace(/\b(LEFT|RIGHT)\s*([(){}\[\]|.<>])/gi, ' $1 $2 ');
    // 구조 문자 둘레에 공백 삽입해서 개별 토큰으로
    src = src.replace(/([{}^_&#])/g, ' $1 ');
    // sub/sup 가 공백 없이 글자에 붙은 경우 분리: e.g. x_i 처리 안전망은 위 정규식이 _ 만 분리.
    var raw = src.split(/\s+/).filter(function(t){ return t.length; });
    return raw;
  }

  // 토큰 배열 → atom 트리 ({t:'tok'|'grp'|'raw', ...})
  function parse(tokens){
    var i = 0;
    function group(stopBrace){
      var atoms = [];
      while(i < tokens.length){
        var t = tokens[i];
        if(t === '}'){ if(stopBrace){ i++; } break; }
        if(t === '{'){ i++; atoms.push({t:'grp', body:group(true)}); continue; }
        i++; atoms.push({t:'tok', v:t});
      }
      return atoms;
    }
    return group(false);
  }

  function isTok(a,v){ return a && a.t==='tok' && a.v.toLowerCase()===v; }

  function mapToken(tok){
    var low = tok.toLowerCase();
    if(PREFIX1[low] || MATRIX_ENV[tok] || FUNCS[low]) return null; // 별도 처리
    if(low==='over'||low==='atop'||low==='left'||low==='right') return null;
    if(GREEK[low]){
      // 모두 대문자면 대문자 그리스
      if(tok===tok.toUpperCase() && tok.length>1 && GREEK_UPPER[low]) return GREEK_UPPER[low];
      return GREEK[low];
    }
    if(SYMBOL[tok] !== undefined) return SYMBOL[tok];
    if(SYMBOL[low] !== undefined) return SYMBOL[low];
    // 이스케이프가 필요한 LaTeX 특수문자
    if(tok==='%') return '\\%';
    if(tok==='$') return '\\$';
    if(tok==='~') return '\\sim';
    return tok; // 숫자/영문/연산자( = + - ( ) 등 )는 그대로
  }

  // atom 하나를 LaTeX로 (그룹은 중괄호 없이 내부만)
  function emitAtom(a){
    if(!a) return '';
    if(a.t==='raw') return a.v;
    if(a.t==='grp') return toLatex(a.body);
    return mapToken(a.v);
  }
  function braced(a){
    if(a && a.t==='grp') return '{'+toLatex(a.body)+'}';
    var s = emitAtom(a);
    return '{'+s+'}';
  }

  // over(분수) 선처리: A over B → raw \frac{A}{B}
  function resolveFractions(atoms){
    var out = atoms.slice();
    for(var i=0;i<out.length;i++){
      if(isTok(out[i],'over') || isTok(out[i],'atop')){
        var op = isTok(out[i],'over') ? '\\frac' : '\\genfrac{}{}{0pt}{}';
        var L = out[i-1], R = out[i+1];
        var raw = { t:'raw', v: op + braced(L) + braced(R) };
        out.splice(i-1, 3, raw);
        i = i-1;
      }
    }
    return out;
  }

  function emitMatrix(env, bodyAtoms){
    // 그룹 본문을 # 로 행, & 로 열 분리
    var rows = [[ [] ]];           // rows[r][c] = atoms[]
    var r=0, c=0;
    bodyAtoms.forEach(function(a){
      if(isTok(a,'#') || (a.t==='tok'&&a.v==='#')){ r++; c=0; rows[r]=[[]]; }
      else if(a.t==='tok'&&a.v==='&'){ c++; rows[r][c]=[]; }
      else { rows[r][c].push(a); }
    });
    var body = rows.map(function(row){
      return row.map(function(cell){ return toLatex(cell); }).join(' & ');
    }).join(' \\\\ ');
    return '\\begin{'+env+'} '+body+' \\end{'+env+'}';
  }

  // atom 리스트 → LaTeX
  function toLatex(atoms){
    atoms = resolveFractions(atoms);
    var out = [];
    var hasAlign = false;
    for(var i=0;i<atoms.length;i++){
      var a = atoms[i];
      if(a.t==='grp'){ out.push('{'+toLatex(a.body)+'}'); continue; }
      if(a.t==='raw'){ out.push(a.v); continue; }
      var v = a.v, low = v.toLowerCase();

      if(v==='^' || v==='_'){ out.push(v + braced(atoms[++i])); continue; }
      if(v==='#'){ out.push('\\\\'); hasAlign=true; continue; }
      if(v==='&'){ out.push('&'); hasAlign=true; continue; }

      if(MATRIX_ENV[v]){ out.push(emitMatrix(MATRIX_ENV[v], (atoms[i+1]&&atoms[i+1].t==='grp')?atoms[++i].body:[])); continue; }
      if(PREFIX1[low]){
        var arg = atoms[++i];
        out.push(PREFIX1[low] + braced(arg));
        continue;
      }
      if(FUNCS[low]){ out.push(FUNCS[low]); continue; }
      if(low==='left'){ var d=atoms[++i]; out.push('\\left'+ (DELIM[d&&d.v]||DELIM[(d&&d.v||'').toLowerCase()]||'.')); continue; }
      if(low==='right'){ var d2=atoms[++i]; out.push('\\right'+ (DELIM[d2&&d2.v]||DELIM[(d2&&d2.v||'').toLowerCase()]||'.')); continue; }

      out.push(mapToken(v));
    }
    var latex = out.join(' ');
    return latex;
  }

  // 최상위: 정렬(#,&)이 있으면 aligned 로 감싼다
  function scriptToLatex(script){
    if(!script || !script.trim()) return '';
    var atoms = parse(tokenize(script));
    // 최상위에 행/열 구분이 있는지 검사 (matrix 안쪽은 group 이라 제외됨)
    var topHasAlign = atoms.some(function(a){ return a.t==='tok' && (a.v==='#'||a.v==='&'); });
    var body = toLatex(atoms);
    if(topHasAlign){
      return '\\begin{aligned} '+ body +' \\end{aligned}';
    }
    return body;
  }

  // KaTeX 로 렌더 → HTML 문자열. 실패하면 원본 스크립트 박스.
  function renderToHtml(script, displayMode){
    var latex = '';
    try { latex = scriptToLatex(script); } catch(e){ latex = ''; }
    if(typeof katex !== 'undefined' && latex){
      try{
        return katex.renderToString(latex, {
          displayMode: !!displayMode, throwOnError:false, strict:false,
          trust:true, output:'html'
        });
      }catch(e){ /* fall through */ }
    }
    // 폴백: 원본 스크립트를 그대로 보여줌
    var safe = unescapeXml(script).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});
    return '<span class="hp-eq-raw" title="수식 변환 실패 — 원본 스크립트">'+safe+'</span>';
  }

  root.HWPEqn = {
    toLatex: scriptToLatex,
    render: renderToHtml,
    _tokenize: tokenize,
    _parse: parse
  };
})(typeof window !== 'undefined' ? window : globalThis);
