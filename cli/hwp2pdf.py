#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hwp2pdf.py — 한글(HWP/HWPX) → PDF 변환기 [최고 품질 CLI]

원본 스크립트(pyhwp→HTML→weasyprint)를 재설계한 버전입니다.
가장 큰 변화: **LibreOffice + H2Orestart 확장**을 주력 엔진으로 사용합니다.

  · H2Orestart 는 LibreOffice 에 .hwp/.hwpx 가져오기 필터를 추가하는 오픈소스 확장으로,
    한컴 한글 없이도 표·다단·수식·글꼴 충실도가 pyhwp 보다 압도적으로 좋습니다.
  · .hwp(구형 바이너리)와 .hwpx(신형 XML)를 모두 "직접" 열어 PDF 로 변환합니다.
    (예전 스크립트는 pyhwp 로 ODT 를 거쳐 품질이 떨어졌습니다.)

신뢰성 보강:
  · 변환마다 격리된 사용자 프로필을 써서 "다른 인스턴스 실행 중" 잠금/동시성 문제를 피함
  · 타임아웃·재시도·출력 검증
  · `doctor` 로 LibreOffice·확장·한글 글꼴 설치 상태 점검
  · `--install-h2orestart` 로 확장 자동 설치(시도)

────────────────────────────────────────────────────────────────────────
설치
    1) LibreOffice 설치
         macOS : brew install --cask libreoffice   (또는 libreoffice.org)
         Windows/Linux : https://www.libreoffice.org
    2) H2Orestart 확장 설치 (둘 중 하나)
         python hwp2pdf.py --install-h2orestart      # 자동(GitHub 최신 릴리스)
         # 수동: https://github.com/ebandal/H2Orestart/releases 에서 H2Orestart.oxt 받아
         #       LibreOffice → 도구 → 확장 관리자 → 추가
    3) 한글 글꼴(없으면 글자가 깨질 수 있음)
         macOS 는 기본 내장. Linux : 'Noto CJK', '나눔글꼴' 등 설치 권장.

사용법
    python hwp2pdf.py 파일.hwp                 # 같은 폴더에 파일.pdf
    python hwp2pdf.py 파일.hwpx -o 출력폴더
    python hwp2pdf.py *.hwp *.hwpx             # 여러 개 일괄
    python hwp2pdf.py 문서폴더/                 # 폴더 내 모든 hwp/hwpx
    python hwp2pdf.py doctor                   # 환경 점검
    python hwp2pdf.py --install-h2orestart     # 확장 자동 설치
────────────────────────────────────────────────────────────────────────
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

# ----------------------------------------------------------------------
# 도구 탐지
# ----------------------------------------------------------------------
def _candidates(names, extra):
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    for p in extra:
        if os.path.exists(p):
            return p
    return None


def find_soffice():
    if sys.platform == "darwin":
        extra = ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
    elif sys.platform.startswith("win"):
        extra = [r"C:\Program Files\LibreOffice\program\soffice.exe",
                 r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"]
    else:
        extra = ["/usr/bin/soffice", "/usr/bin/libreoffice",
                 "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice"]
    return _candidates(["soffice", "libreoffice"], extra)


def find_unopkg(soffice):
    """soffice 옆의 unopkg(확장 관리 CLI)를 찾는다."""
    if not soffice:
        return shutil.which("unopkg")
    d = Path(soffice).parent
    for name in ("unopkg", "unopkg.exe", "unopkg.bin"):
        cand = d / name
        if cand.exists():
            return str(cand)
    return shutil.which("unopkg")


# ----------------------------------------------------------------------
# H2Orestart 확장
# ----------------------------------------------------------------------
def h2orestart_installed(unopkg):
    if not unopkg:
        return False
    try:
        out = subprocess.run([unopkg, "list"], capture_output=True, text=True, timeout=60)
        blob = ((out.stdout or "") + (out.stderr or "")).lower()
        return ("h2orestart" in blob) or ("hwp" in blob and "ebandal" in blob)
    except Exception:
        return False


def install_h2orestart(unopkg):
    """GitHub 최신 릴리스에서 H2Orestart.oxt 를 받아 설치(시도)."""
    if not unopkg:
        print("❌ unopkg 를 찾지 못했습니다. LibreOffice 가 설치되어 있나요?")
        return 1
    try:
        import json
        import urllib.request
        api = "https://api.github.com/repos/ebandal/H2Orestart/releases/latest"
        print("· 최신 릴리스 조회 중…")
        with urllib.request.urlopen(api, timeout=30) as r:
            data = json.load(r)
        url = None
        for a in data.get("assets", []):
            if a.get("name", "").lower().endswith(".oxt"):
                url = a["browser_download_url"]
                break
        if not url:
            print("❌ 릴리스에서 .oxt 자산을 찾지 못했습니다. 수동 설치를 이용하세요.")
            return 1
        tmp = Path(tempfile.gettempdir()) / "H2Orestart.oxt"
        print(f"· 다운로드: {url}")
        urllib.request.urlretrieve(url, tmp)
        print("· 설치(unopkg add)…")
        res = subprocess.run([unopkg, "add", "-f", str(tmp)], capture_output=True, text=True, timeout=180)
        if res.returncode == 0:
            print("✅ H2Orestart 설치 완료!")
            return 0
        print("❌ 설치 실패:\n" + (res.stderr or res.stdout))
        return 1
    except Exception as e:
        print(f"❌ 자동 설치 실패: {e}\n   수동: https://github.com/ebandal/H2Orestart/releases")
        return 1


# ----------------------------------------------------------------------
# 변환
# ----------------------------------------------------------------------
def convert(soffice, src: Path, out_dir: Path, timeout=240, retries=1) -> Path:
    """LibreOffice(+H2Orestart) 로 .hwp/.hwpx → PDF. 격리 프로필 사용."""
    out_dir.mkdir(parents=True, exist_ok=True)
    final_pdf = out_dir / (src.stem + ".pdf")
    last_err = ""
    for attempt in range(retries + 1):
        profile = Path(tempfile.gettempdir()) / f"lo_profile_{uuid.uuid4().hex[:8]}"
        # macOS/Linux file URI
        prof_uri = profile.as_uri()
        cmd = [
            soffice, "--headless", "--norestore", "--nolockcheck", "--nodefault",
            f"-env:UserInstallation={prof_uri}",
            "--convert-to", "pdf:writer_pdf_Export",
            "--outdir", str(out_dir), str(src),
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            # soffice 는 출력 파일명을 stem.pdf 로 만든다
            produced = out_dir / (src.stem + ".pdf")
            if produced.exists() and produced.stat().st_size > 0:
                return produced
            last_err = (r.stderr or r.stdout or "출력 파일이 생성되지 않음").strip()
        except subprocess.TimeoutExpired:
            last_err = f"시간 초과({timeout}s)"
        finally:
            shutil.rmtree(profile, ignore_errors=True)
    raise RuntimeError(last_err or "변환 실패")


def collect_targets(inputs):
    targets = []
    for item in inputs:
        p = Path(item)
        if p.is_dir():
            for ext in ("*.hwp", "*.hwpx", "*.HWP", "*.HWPX"):
                targets.extend(sorted(p.glob(ext)))
        elif p.is_file():
            targets.append(p)
        else:
            print(f"  ⚠️  건너뜀(존재하지 않음): {item}")
    # 중복 제거
    seen, uniq = set(), []
    for t in targets:
        k = str(t.resolve())
        if k not in seen:
            seen.add(k); uniq.append(t)
    return uniq


# ----------------------------------------------------------------------
# doctor
# ----------------------------------------------------------------------
def doctor():
    print("🩺 환경 점검\n" + "─" * 40)
    soffice = find_soffice()
    print(f"LibreOffice : {'✅ ' + soffice if soffice else '❌ 미설치  → https://www.libreoffice.org'}")
    unopkg = find_unopkg(soffice)
    print(f"unopkg      : {'✅ ' + unopkg if unopkg else '❌ 없음'}")
    has_ext = h2orestart_installed(unopkg)
    print(f"H2Orestart  : {'✅ 설치됨' if has_ext else '❌ 미설치  → python hwp2pdf.py --install-h2orestart'}")

    # 한글 글꼴
    fonts = "?"
    try:
        if shutil.which("fc-list"):
            out = subprocess.run(["fc-list", ":lang=ko"], capture_output=True, text=True, timeout=30)
            n = len([l for l in out.stdout.splitlines() if l.strip()])
            fonts = f"✅ 한글 글꼴 {n}종" if n else "⚠️ 한글 글꼴 없음(나눔/Noto CJK 설치 권장)"
        elif sys.platform == "darwin":
            fonts = "✅ (macOS 기본 한글 글꼴 사용)"
        else:
            fonts = "? (fc-list 없음)"
    except Exception:
        fonts = "?"
    print(f"한글 글꼴    : {fonts}")
    print("─" * 40)
    ready = bool(soffice and has_ext)
    print("준비 완료 ✅" if ready else "위 항목을 먼저 갖춰 주세요 ⛏️")
    return 0 if ready else 1


# ----------------------------------------------------------------------
# main
# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description="한글(HWP/HWPX) → PDF 변환 [LibreOffice + H2Orestart, 최고 품질]")
    ap.add_argument("inputs", nargs="*", help="HWP/HWPX 파일 또는 폴더 (여러 개 가능) · 'doctor' 가능")
    ap.add_argument("-o", "--outdir", default=None, help="출력 폴더 (기본: 원본과 같은 폴더)")
    ap.add_argument("--timeout", type=int, default=240, help="파일당 변환 제한 시간(초)")
    ap.add_argument("--retries", type=int, default=1, help="실패 시 재시도 횟수")
    ap.add_argument("--install-h2orestart", action="store_true", help="H2Orestart 확장 자동 설치")
    args = ap.parse_args()

    soffice = find_soffice()
    unopkg = find_unopkg(soffice)

    if args.install_h2orestart:
        sys.exit(install_h2orestart(unopkg))

    if args.inputs == ["doctor"]:
        sys.exit(doctor())

    if not args.inputs:
        ap.print_help()
        sys.exit(1)

    if not soffice:
        print("❌ LibreOffice 를 찾지 못했습니다.\n   설치: https://www.libreoffice.org  (macOS: brew install --cask libreoffice)")
        sys.exit(1)
    if not h2orestart_installed(unopkg):
        print("⚠️  H2Orestart 확장이 보이지 않습니다. .hwp/.hwpx 변환이 실패할 수 있어요.")
        print("    설치: python hwp2pdf.py --install-h2orestart\n")

    targets = collect_targets(args.inputs)
    if not targets:
        print("❌ 변환할 HWP/HWPX 파일을 찾지 못했습니다.")
        sys.exit(1)

    print(f"📄 변환 대상 {len(targets)}개 | 엔진: LibreOffice + H2Orestart\n")
    ok = fail = 0
    for src in targets:
        out_dir = Path(args.outdir) if args.outdir else src.parent
        try:
            pdf = convert(soffice, src, out_dir, timeout=args.timeout, retries=args.retries)
            print(f"  ✅ {src.name}  →  {pdf}")
            ok += 1
        except Exception as e:
            print(f"  ❌ {src.name}  실패: {e}")
            fail += 1

    print(f"\n완료: 성공 {ok} / 실패 {fail}")
    sys.exit(0 if fail == 0 else 2)


if __name__ == "__main__":
    main()
