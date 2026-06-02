# 오픈소스 라이선스 고지 (Third-Party Licenses)

이 프로젝트(**hwp-to-pdf**)는 아래의 오픈소스 소프트웨어를 사용합니다. 각 저작권자와 라이선스에 감사드립니다. 웹앱은 이 라이브러리들을 CDN(jsDelivr · Google Fonts · esm.sh)에서 불러오며, 저장소에 직접 포함(재배포)하지는 않습니다.

## 웹앱에서 사용하는 라이브러리

| 라이브러리 | 용도 | 라이선스 | 저작권 |
|---|---|---|---|
| [JSZip](https://github.com/Stuk/jszip) | `.hwpx`(ZIP) 압축 해제 | MIT 또는 GPL-3.0-or-later (듀얼) | © 2009–2016 Stuart Knightley 및 기여자 |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 수식 렌더링 | MIT | © 2013–2020 Khan Academy 및 기여자 |
| [jsPDF](https://github.com/parallax/jsPDF) | 이미지 PDF 생성 | MIT | © 2010–2021 James Hall, yWorks GmbH 및 기여자 |
| [html2canvas](https://github.com/niklasvh/html2canvas) | 화면 → 캔버스 캡처 | MIT | © Niklas von Hertzen 및 기여자 |
| [SheetJS `cfb`](https://github.com/SheetJS/js-cfb) | `.hwp`(OLE/CFB) 컨테이너 읽기 | Apache-2.0 | © SheetJS LLC |
| [pako](https://github.com/nodeca/pako) | `.hwp` 스트림 압축 해제(raw inflate) | MIT | © Vitaly Puzrin, Andrei Tuputcyn |
| [docx-preview](https://github.com/VolodymyrBaydalka/docxjs) | `.docx` 렌더링 | Apache-2.0 | © Volodymyr Baydalka 및 기여자 |
| [Noto Sans KR / Noto Serif KR](https://fonts.google.com/noto) | 한글 글꼴(폴백) | SIL Open Font License 1.1 | © Google LLC |

## CLI(`cli/hwp2pdf.py`)에서 사용하는 외부 도구

이 도구들은 본 저장소에 포함되지 않으며, 이용자가 직접 설치합니다.

| 도구 | 라이선스 | 비고 |
|---|---|---|
| [LibreOffice](https://www.libreoffice.org) | MPL-2.0 | 변환 엔진 |
| [H2Orestart](https://github.com/ebandal/H2Orestart) | GPL-3.0 | LibreOffice용 HWP/HWPX 가져오기 확장 (© ebandal) |

---

### 상표 고지
'한글', 'HWP', 'HWPX', '한컴오피스'는 ㈜한글과컴퓨터의 상표입니다. 본 프로젝트는 한글과컴퓨터와 무관한 독립 오픈소스 프로젝트이며 제휴·후원·보증 관계가 없습니다. HWPX(OWPML)는 공개된 문서 표준입니다.

### 본 프로젝트 라이선스
MIT License — © 2026 구민준 (fakeminjun7321). 전문은 [`LICENSE`](LICENSE) 참조.

각 라이선스 전문은 위 링크의 원 저장소에서 확인할 수 있습니다.
