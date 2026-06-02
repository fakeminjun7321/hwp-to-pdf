# 한글 문서 PDF 변환기 (HWP · HWPX → PDF)

**브라우저에서 바로 한글(HWP/HWPX) 문서를 PDF로.** 파일이 서버로 전송되지 않고 100% 내 컴퓨터(브라우저) 안에서만 처리됩니다. 정적 사이트라 GitHub Pages 링크 하나로 어디서든 사용할 수 있어요.

> 🔗 **데모: https://fakeminjun7321.github.io/hwp-to-pdf/**

---

## ✨ 무엇이 좋아졌나

원래는 파이썬 스크립트(`pyhwp → HTML → weasyprint`)였습니다. 이 저장소는 두 갈래로 발전시켰습니다.

| | 이 저장소 |
|---|---|
| **웹앱** (이 폴더) | 설치 0 · 업로드 0 · 드래그&드롭 · `.hwp`/`.hwpx` 모두 · 수식(KaTeX) · 표 · 그림 · 다중 파일 일괄 |
| **CLI** (`cli/hwp2pdf.py`) | LibreOffice + **H2Orestart** 기반 *최고 충실도* 변환 (픽셀 단위로 똑같이 필요할 때) |

### 웹앱 핵심
- **`.hwpx`** : 한컴 XML(OWPML)을 직접 해석하는 자체 렌더러 — 글자모양/문단모양/정렬/줄간격/색/표/그림을 HWPUNIT(1/7200인치) 단위까지 충실히 재현.
- **수식** : 한글 수식 스크립트(`{A} over {B}`, `pmatrix{…}`, `sqrt`, `gamma`, `LEFT( … RIGHT)` …)를 LaTeX로 변환해 **KaTeX**로 렌더. (실제 물리 보고서 61개 수식 → 100% 렌더 확인)
- **`.hwp`** (구형 바이너리) : 한글이 저장해 둔 **첫 페이지 미리보기**(PrvImage)와 텍스트(PrvText)를 추출해 표시. 정밀 변환은 `.hwpx`로 저장 후 권장.
- **PDF 출력 2가지**
  - **PDF로 저장(인쇄)** — 브라우저 인쇄로 저장. 텍스트가 살아있는 **벡터 PDF**(검색·복사 가능), 용지/여백을 원본대로. *가장 정확.*
  - **이미지 PDF** — 클릭 한 번에 다운로드(여러 페이지 자동 분할). 글자가 이미지로 들어감.

---

## 🚀 사용법 (웹앱)

1. 위 데모 링크를 열거나, 로컬에서 정적 서버로 실행:
   ```bash
   cd hwp-to-pdf
   python3 -m http.server 4178
   # 브라우저에서 http://localhost:4178
   ```
2. `.hwp` / `.hwpx` 파일을 끌어다 놓기 (또는 *파일 선택*).
3. 미리보기 확인 → **PDF로 저장**(권장) 또는 **이미지 PDF**.

> 인터넷이 필요한 부분은 글꼴·KaTeX·라이브러리 CDN 로드뿐이며, **문서 데이터는 절대 외부로 나가지 않습니다.**

---

## 🖥️ 최고 충실도가 필요하면: CLI

표·다단·수식까지 한컴과 거의 동일하게 뽑아야 한다면 LibreOffice + H2Orestart 경로를 쓰세요.

```bash
# 1) LibreOffice 설치 (macOS)
brew install --cask libreoffice
# 2) H2Orestart 확장 자동 설치
python3 cli/hwp2pdf.py --install-h2orestart
# 3) 환경 점검
python3 cli/hwp2pdf.py doctor
# 4) 변환
python3 cli/hwp2pdf.py 보고서.hwpx
python3 cli/hwp2pdf.py *.hwp *.hwpx -o out/
python3 cli/hwp2pdf.py 문서폴더/
```

핵심 개선: 예전 `pyhwp` 대신 **H2Orestart**가 `.hwp/.hwpx`를 직접 열어 PDF로 변환하므로 충실도가 크게 높고, 변환마다 **격리된 프로필**을 써서 잠금/동시성 오류를 피합니다.

---

## 🌐 GitHub Pages 배포

```bash
cd hwp-to-pdf
git init && git add . && git commit -m "한글 PDF 변환기"
gh repo create hwp-to-pdf --public --source=. --push   # gh CLI 사용 시
# 또는 github.com 에서 빈 저장소 만들고:
#   git remote add origin https://github.com/<your-id>/hwp-to-pdf.git
#   git push -u origin main
```
GitHub → 저장소 **Settings → Pages → Branch: main / root** 선택 → 몇 분 뒤 `https://<your-id>.github.io/hwp-to-pdf/` 공개.

> `samples/` 폴더(개인 문서)와 `*.pdf` 는 `.gitignore` 로 제외됩니다.

---

## 🧩 구조

```
index.html      UI / 라이브러리 로드
styles.css      스타일 + 인쇄(@page) 규칙
app.js          파일 입력·드래그, 디스패치, 미리보기, PDF 출력
hwpx.js         HWPX(OWPML) → HTML 렌더러
hwpeqn.js       한글 수식 스크립트 → LaTeX (KaTeX)
cli/hwp2pdf.py  LibreOffice + H2Orestart 최고 충실도 CLI
```

의존 라이브러리(CDN): JSZip(압축 해제), KaTeX(수식), jsPDF·html2canvas(이미지 PDF), `cfb`(.hwp OLE 읽기), Noto Sans/Serif KR(글꼴).

## ⚠️ 알려진 한계
- `.hwp`(구형)는 첫 페이지 미리보기 위주 — 전체/정밀 변환은 `.hwpx` 권장 또는 CLI 사용.
- 아주 특수한 수식 기호는 원본 스크립트로 표시될 수 있음(렌더 실패 시 폴백).
- 머리말/꼬리말·각주·복잡한 도형은 부분 지원.

## 📄 라이선스 · 법적 고지
- 본 프로젝트: **MIT License** — © 2026 구민준 ([`LICENSE`](LICENSE))
- 사용된 오픈소스 출처·라이선스: [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) (사이트 하단 *법적 고지 · 오픈소스 라이선스*에서도 확인 가능)
- **면책**: 변환 결과를 보증하지 않으며(as-is) 중요한 문서는 원본을 보관하세요. 이용자는 변환 문서에 대한 정당한 권리를 보유해야 합니다.
- **상표**: ‘한글’·‘HWP’·‘HWPX’는 ㈜한글과컴퓨터의 상표이며, 본 프로젝트는 한컴과 무관한 독립 오픈소스입니다. HWPX(OWPML)는 공개 표준입니다.
- **개인정보**: 문서를 서버로 전송·저장하지 않고 전부 브라우저에서 처리합니다. 쿠키·트래킹·광고 없음. (라이브러리·글꼴은 CDN에서 로드)
