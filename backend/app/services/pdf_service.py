"""판독서 PDF 생성 (F-9/D-4) — 화면분석 §5.7 사이트 템플릿(헤더/푸터/기관정보/페이지번호).

한글: reportlab 내장 CID 폰트(HYSMyeongJo-Medium) — 폰트 파일 배포 불필요.
"""
from __future__ import annotations

import io
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    HRFlowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from sqlalchemy.orm import Session

from app.models import Patient, Report
from app.services.settings_service import get_setting

_FONT = "HYSMyeongJo-Medium"
_registered = False


def _ensure_font() -> None:
    global _registered
    if not _registered:
        pdfmetrics.registerFont(UnicodeCIDFont(_FONT))
        _registered = True


def _style(size: int = 10, *, bold: bool = False, color=colors.black) -> ParagraphStyle:
    return ParagraphStyle(
        name=f"s{size}{bold}",
        fontName=_FONT,
        fontSize=size,
        leading=size * 1.5,
        textColor=color,
    )


def render_report_pdf(db: Session, report: Report) -> bytes:
    _ensure_font()
    study = report.study
    patient = db.get(Patient, study.patient_id)
    site = get_setting(db, "pdf.template", default={}) or {}
    hospital = site.get("hospital", "Saintview PACS AI")
    department = site.get("department", "영상의학과")
    footer_text = site.get("footer", "")

    buf = io.BytesIO()

    def _decorate(canvas, doc):
        canvas.saveState()
        canvas.setFont(_FONT, 8)
        # 페이지 번호 (우측 하단 — 화면분석 §5.7)
        canvas.drawRightString(200 * mm, 12 * mm, f"- {doc.page} -")
        if footer_text:
            canvas.drawString(15 * mm, 12 * mm, footer_text)
        canvas.restoreState()

    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=20 * mm,
        title=f"판독서 {study.accession_no or study.study_uid}",
    )

    story = []
    # 기관 헤더
    story.append(Paragraph(hospital, _style(16, bold=True)))
    story.append(Paragraph(f"{department} 판독 보고서", _style(11, color=colors.HexColor("#555555"))))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.black, spaceAfter=6))

    # 환자·검사 메타 테이블 (디자인 §3 [E-중] 메타와 동일 구성)
    meta = [
        ["환자 ID", patient.patient_key if patient else "", "이름", patient.name_masked if patient else "",
         "성별/생년", f"{patient.sex or '-'} / {patient.birth_date or '-'}" if patient else "-"],
        ["Accession", study.accession_no or "-", "검사명", study.study_desc or "-",
         "검사일", f"{study.study_date} {study.study_time}"],
        ["Modality", study.modality or "-", "부위", study.body_part or "-",
         "보고서", f"v{report.version} / {report.status}"],
    ]
    t = Table(meta, colWidths=[20 * mm, 32 * mm, 16 * mm, 50 * mm, 18 * mm, 40 * mm])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), _FONT),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eeeeee")),
        ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#eeeeee")),
        ("BACKGROUND", (4, 0), (4, -1), colors.HexColor("#eeeeee")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(t)
    story.append(Spacer(1, 6 * mm))

    sr = report.sr_json or {}

    def _section(title: str):
        story.append(Paragraph(title, _style(12, bold=True)))
        story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#888888"), spaceAfter=3))

    comp = sr.get("comparison", {})
    if comp.get("summary"):
        _section("Comparison")
        story.append(Paragraph(comp["summary"], _style(10)))
        story.append(Spacer(1, 4 * mm))

    _section("Findings")
    for f in sr.get("findings", []):
        sev = f.get("severity", "")
        mark = " [CRITICAL]" if sev == "critical" else ""
        story.append(Paragraph(f"• {f.get('organ', '')}: {f.get('observation', '')}{mark}", _style(10)))
    story.append(Spacer(1, 4 * mm))

    _section("Conclusion")
    for imp in sorted(sr.get("impression", []), key=lambda x: x.get("rank", 99)):
        story.append(Paragraph(f"{imp.get('rank', '')}. {imp.get('statement', '')}", _style(10)))
    story.append(Spacer(1, 4 * mm))

    recs = sr.get("recommendations", [])
    if recs:
        _section("Recommend")
        for r in recs:
            tf = f" ({r['timeframe']})" if r.get("timeframe") else ""
            story.append(Paragraph(f"• {r.get('action', '')}{tf}", _style(10)))
        story.append(Spacer(1, 4 * mm))

    # 서명 블록 — 판독의 이름·면허번호 (diff_metrics.signature, 16차)
    story.append(Spacer(1, 6 * mm))
    sig = (report.diff_metrics or {}).get("signature", {})
    signer = sig.get("name") or report.reviewed_by or "-"
    if sig.get("license_no"):
        signer += f" (면허 제{sig['license_no']}호)"
    sign = [
        ["판독", signer,
         "확정일시", report.finalized_at.strftime("%Y-%m-%d %H:%M") if report.finalized_at else "-"],
    ]
    st = Table(sign, colWidths=[18 * mm, 60 * mm, 20 * mm, 60 * mm])
    st.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), _FONT),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eeeeee")),
        ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#eeeeee")),
    ]))
    story.append(st)

    # F-16: 키이미지 첨부 (Orthanc 가용 시)
    key_images = study.key_images or []
    if key_images:
        try:
            from reportlab.platypus import Image as RLImage

            from app.dicom.orthanc import OrthancClient

            client = OrthancClient()
            try:
                if client.alive():
                    imgs = []
                    for ki in key_images[:4]:  # 최대 4장
                        png = client.instance_preview_png(ki.get("orthanc_id", ""))
                        if png:
                            imgs.append(RLImage(io.BytesIO(png), width=55 * mm, height=55 * mm))
                    if imgs:
                        story.append(Spacer(1, 4 * mm))
                        _section("Key Images")
                        story.append(Table([imgs], colWidths=[58 * mm] * len(imgs)))
            finally:
                client.close()
        except Exception:
            pass  # 키이미지 첨부 실패가 PDF 발행을 막지 않는다

    # AI 초안 경고 (절대 규칙 2 — 미확정이면 명시)
    if report.status != "finalized":
        story.append(Spacer(1, 4 * mm))
        story.append(Paragraph(
            "⚠ 본 문서는 AI 생성 초안을 포함하며 의료인의 최종 확정 전입니다.",
            _style(9, color=colors.HexColor("#aa0000")),
        ))
    if report.created_by == "ai" and (sr.get("ai_meta", {}).get("caveats")):
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph(
            f"AI 모델: {report.ai_model} · " + " / ".join(sr["ai_meta"]["caveats"]),
            _style(8, color=colors.HexColor("#777777")),
        ))

    story.append(Spacer(1, 2 * mm))
    story.append(Paragraph(
        f"출력: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        _style(8, color=colors.HexColor("#777777")),
    ))

    doc.build(story, onFirstPage=_decorate, onLaterPages=_decorate)
    return buf.getvalue()
