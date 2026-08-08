"""모의 WebPACS(webpacs_api) 서버 — 브리지 테스트·E2E 하네스용.

인계 서버(SaintViewPACS-handover webpacs_api)의 계약 중 브리지가 의존하는 최소면을
동일 형태로 구현한다(분석: docs/INTEGRATION_WEBPACS.md):
  - POST /api/user/auth/login  {user_id,user_passwd,user_overwrite} → {token,...,status:200}
  - GET  /api/study/           → {study_data:[...], study_count:0(원본 특성 재현), ...}
  - GET  /api/study/count      → {study_count:N}
  - GET  /api/study/{idx}      → {study_data:{...}}
  - GET  /api/study/{idx}/series/viewer → {series_data:[{..., images:[{sop_instance_uid,...}]}]}
  - GET  /api/dicomweb/v2/studies/{s}/series/{se}/instances/{sop} → application/dicom
모든 /api 경로(login 제외)는 Authorization: Bearer 필수 — 무효 토큰 401(재로그인 검증용).

독립 실행: py -3.11 harness/mock_webpacs_api.py --port 8014
테스트: from mock_webpacs_api import build_app → httpx.ASGITransport(app)
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Response

sys.path.insert(0, str(Path(__file__).resolve().parent))

from make_sample_dicom import make_ct_instance  # noqa: E402

MOCK_USER = "webpacs"
MOCK_PASSWORD = "webpacs1234"


def build_app(*, num_studies: int = 2, instances_per_study: int = 3,
              user_id: str = MOCK_USER, password: str = MOCK_PASSWORD) -> FastAPI:
    from pydicom.uid import generate_uid

    app = FastAPI(title="mock webpacs_api")
    # A 는 계정당 단일 유효 토큰 — 계정별 슬롯(서비스 계정+per-user 공존). refresh 지원.
    state = {"tokens": {}, "refresh": {}, "logins": 0}   # user_id → token / refresh_token → user_id

    # 합성 검사 데이터 — 원격 DB 행(pacs_study_view/pacs_series/pacs_image 대응) + DICOM 바이트
    studies: list[dict] = []
    series_by_study: dict[int, list[dict]] = {}
    dicom_bytes: dict[str, bytes] = {}
    dicom_ds: dict[str, object] = {}          # sop → pydicom Dataset (metadata 응답용)
    reports: dict[int, dict] = {}             # study_idx → pacs_study_report 행 (Live 계약)
    annotations: dict[tuple[str, str], dict] = {}   # (study_uid, tool_name) → 행
    claims: dict[int, int] = {}               # study_idx → user_idx (RI 선점자)
    for n in range(1, num_studies + 1):
        study_uid = generate_uid()
        series_uid = generate_uid()
        pid = f"WPX{n:04d}"
        images = []
        for i in range(1, instances_per_study + 1):
            ds = make_ct_instance(
                patient_id=pid, patient_name=f"WEBPACS^MOCK{n}",
                study_uid=study_uid, series_uid=series_uid,
                study_desc=f"CT Chest (webpacs mock {n})", instance_number=i,
            )
            buf = io.BytesIO()
            ds.save_as(buf, write_like_original=False)
            dicom_bytes[ds.SOPInstanceUID] = buf.getvalue()
            dicom_ds[str(ds.SOPInstanceUID)] = ds
            images.append({
                "image_idx": n * 100 + i,
                "sop_instance_uid": str(ds.SOPInstanceUID),
                "bucket_name": "dicom-files",
                "image_file_path": f"2026-07-23/{n}/origin/{i}.dcm",
                "image_sequence": i,
            })
        studies.append({
            "study_idx": n,
            "study_instance_uid": study_uid,
            "study_status": "E",
            "study_modality": "CT",
            "study_body_part": "CHEST",
            "study_datetime": "2026-07-23 12:00:00",
            "study_description": f"CT Chest (webpacs mock {n})",
            "study_accession_no": f"ACC{n:04d}",
            "patient_id": pid,
            "patient_name": f"WEBPACS^MOCK{n}",
            "patient_sex": "M",
            "patient_birthday": "1960-01-01",
            "hospital_idx": 1,
            "hospital_name": "Mock Hospital",
            "series_count": 1,
            "image_count": instances_per_study,
        })
        series_by_study[n] = [{
            "series_idx": n * 10,
            "study_idx": n,
            "study_instance_uid": study_uid,
            "series_instance_uid": series_uid,
            "series_sequence": 1,
            "series_description": "Axial",
            "images": images,
            "image_count": len(images),
        }]

    # 등록 A 계정 — 서비스 계정(webpacs) + per-user 판독의 2명(user_idx 로 구분)
    accounts = {
        # 실제 A 계약: 판독하는 계정은 pacs_doctor 등록(doctor_idx) + 전문의 번호(doctor_major)가
        # 있다 — B 의 판독 저장 자격 게이트(report_permission_error)가 이 세 값을 본다.
        user_id: {"password": password, "user_idx": 1, "user_name": "Mock User", "group_level": 99,
                  "doctor_idx": 1, "doctor_id": "10001", "doctor_major": "90001"},
        "dr_kim": {"password": "kim1234", "user_idx": 11, "user_name": "김판독", "group_level": 50,
                   "doctor_idx": 11, "doctor_id": "10011", "doctor_major": "90011"},
        "dr_lee": {"password": "lee1234", "user_idx": 12, "user_name": "이판독", "group_level": 50,
                   "doctor_idx": 12, "doctor_id": "10012", "doctor_major": "90012"},
        # 전문의 미분류 계정 — 게이트 차단 케이스 검증용(판독 저장이 409 여야 한다)
        "nurse_choi": {"password": "choi1234", "user_idx": 13, "user_name": "최간호", "group_level": 30},
    }

    def _auth(authorization: str | None) -> dict | None:
        """반환: 인증된 계정 정보(user_idx·user_name) 또는 401. 계정별 단일 유효 토큰."""
        token = (authorization or "").removeprefix("Bearer ").strip()
        for uid, tok in state["tokens"].items():
            if token and token == tok:
                return {"user_id": uid, **accounts.get(uid, {})}
        raise HTTPException(status_code=401, detail="token invalid")

    @app.post("/api/user/auth/login")
    def login(body: dict):
        uid = body.get("user_id")
        acc = accounts.get(uid)
        if not acc or body.get("user_passwd") != acc["password"]:
            return {"status": 401, "message": "login failed", "token": None}
        state["logins"] += 1
        tok = f"mock-token-{uid}-{state['logins']}"
        state["tokens"][uid] = tok   # 계정당 최신 토큰(이전 토큰 무효화)
        refresh = f"mock-refresh-{uid}"
        state["refresh"][refresh] = uid
        return {
            "user_data": {"user_idx": acc["user_idx"], "user_id": uid,
                          "user_name": acc["user_name"], "group_idx": 1,
                          "group_level": acc["group_level"],
                          "doctor_idx": acc.get("doctor_idx"),
                          "doctor_id": acc.get("doctor_id"),
                          "doctor_major": acc.get("doctor_major")},
            "token": tok, "refresh_token": refresh,
            "message": "user login successful", "status": 200,
        }

    @app.post("/api/user/auth/refresh")
    def refresh(body: dict, authorization: str | None = Header(default=None)):
        rt = body.get("refresh_token")
        uid = state["refresh"].get(rt)
        if not uid:
            raise HTTPException(status_code=401, detail="refresh expired")
        state["logins"] += 1
        tok = f"mock-token-{uid}-{state['logins']}"
        state["tokens"][uid] = tok
        return {"token_access": tok, "status": 200, "message": "refresh token"}

    in_progress: set[int] = set()   # RI(작성중) — change_status/report 로 진입

    def _status_of(idx: int, base: str) -> str:
        """A 시맨틱 재현: RI 선점 > 리포트 상태(트리거) > 기본."""
        if idx in in_progress:
            return "RI"
        rep = reports.get(idx)
        if rep:
            return rep.get("report_status") or base
        return base

    def _hydrate(row: dict) -> dict:
        """정적 행 + 동적 상태(판독/선점) 병합 — pacs_study_view 동형."""
        idx = row["study_idx"]
        out = dict(row)
        out["study_status"] = _status_of(idx, row.get("study_status") or "E")
        rep = reports.get(idx)
        out["report_conclusion"] = (rep or {}).get("report_conclusion") or ""
        out["report_reading"] = (rep or {}).get("report_reading") or ""
        out["report_status"] = (rep or {}).get("report_status") or ""
        claimer = claims.get(idx)
        out["user_idx"] = claimer
        out["doctor_user_name"] = f"Mock Doctor {claimer}" if claimer else ""
        return out

    @app.get("/api/study/")
    def study_list(limit: str = "300", offset: str = "0", patient_id: str | None = None,
                   patient_name: str | None = None, study_modality: str | None = None,
                   study_search: str | None = None, order_json: str | None = None,
                   authorization: str | None = Header(default=None)):
        state["list_calls"] = state.get("list_calls", 0) + 1
        _auth(authorization)
        rows = studies
        if patient_id:
            rows = [r for r in rows if patient_id in r["patient_id"]]
        if patient_name:
            rows = [r for r in rows if patient_name.lower() in r["patient_name"].lower()]
        if study_modality:
            rows = [r for r in rows if r["study_modality"] == study_modality]
        if study_search:
            q = study_search.lower()
            rows = [r for r in rows
                    if q in r["patient_name"].lower() or q in r["patient_id"].lower()
                    or q in r["study_description"].lower()]
        if order_json and "desc" in order_json:
            rows = sorted(rows, key=lambda r: r["study_idx"], reverse=True)
        off, lim = int(offset or 0), int(limit or 300)
        page = [_hydrate(r) for r in rows[off:off + lim]]
        # 원본 특성 재현: 목록의 study_count 는 0 하드코딩(총개수는 /count)
        return {"study_data": page, "study_count": 0, "study_data_count": len(page),
                "message": "ok", "status": 200}

    @app.get("/api/study/count")
    def study_count(patient_id: str | None = None, patient_name: str | None = None,
                    study_modality: str | None = None, study_search: str | None = None,
                    authorization: str | None = Header(default=None)):
        _auth(authorization)
        rows = studies
        if patient_id:
            rows = [r for r in rows if patient_id in r["patient_id"]]
        if patient_name:
            rows = [r for r in rows if patient_name.lower() in r["patient_name"].lower()]
        if study_modality:
            rows = [r for r in rows if r["study_modality"] == study_modality]
        return {"study_count": len(rows), "message": "ok", "status": 200}

    @app.get("/api/study/study_keys")
    def study_keys(authorization: str | None = Header(default=None)):
        _auth(authorization)
        return {"study_data": [{"study_idx": r["study_idx"],
                                "study_status": _hydrate(r)["study_status"]} for r in studies],
                "message": "ok", "status": 200}

    @app.get("/api/study/{study_idx}")
    def study_detail(study_idx: int, authorization: str | None = Header(default=None)):
        _auth(authorization)
        for r in studies:
            if r["study_idx"] == study_idx:
                return {"study_data": _hydrate(r), "message": "ok", "status": 200}
        raise HTTPException(status_code=404, detail="study not found")

    @app.get("/api/study/{study_idx}/series/viewer")
    def series_viewer(study_idx: int, authorization: str | None = Header(default=None)):
        _auth(authorization)
        rows = series_by_study.get(study_idx)
        if rows is None:
            raise HTTPException(status_code=404, detail="study not found")
        return {"series_data": rows, "series_count": len(rows),
                "series_data_count": len(rows), "message": "ok", "status": 200}

    @app.get("/api/dicomweb/v2/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}")
    def instance_file(study_uid: str, series_uid: str, sop_uid: str,
                      authorization: str | None = Header(default=None)):
        _auth(authorization)
        data = dicom_bytes.get(sop_uid)
        if data is None:
            raise HTTPException(status_code=404, detail="instance not found")
        state["instance_calls"] = state.get("instance_calls", 0) + 1
        return Response(content=data, media_type="application/dicom")

    @app.get("/api/dicomweb/v2/studies/{study_uid}/series/{series_uid}/metadata")
    def series_metadata(study_uid: str, series_uid: str,
                        authorization: str | None = Header(default=None)):
        _auth(authorization)
        out = []
        for ds in dicom_ds.values():
            if str(getattr(ds, "SeriesInstanceUID", "")) == series_uid:
                out.append(ds.to_json_dict())   # dicom+json (A v2 동형)
        if not out:
            raise HTTPException(status_code=404, detail="series not found")
        return out

    @app.get("/api/dicomweb/v2/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/thumbnail")
    def thumbnail(study_uid: str, series_uid: str, sop_uid: str,
                  authorization: str | None = Header(default=None)):
        _auth(authorization)
        if sop_uid not in dicom_bytes:
            raise HTTPException(status_code=404, detail="instance not found")
        import io as _io

        from PIL import Image

        buf = _io.BytesIO()
        Image.new("L", (32, 32), color=96).save(buf, format="JPEG")
        return Response(content=buf.getvalue(), media_type="image/jpeg")

    # A 가 배치로 미리 만들어 두는 저해상 렌더(rendered/{sop}_512x512_q80.jpg) 서빙 경로.
    # 실서버는 v1 Dicomweb.py 의 /rendered 가 Redis→MinIO 사전생성본→즉석렌더 순으로 응답한다.
    # 사전생성본을 타려면 viewport=512x512 & quality=80 & window 없음 이어야 한다.
    @app.get("/api/dicomweb/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/rendered")
    def rendered_v1(study_uid: str, series_uid: str, sop_uid: str,
                    viewport: str = "", quality: int = 0, window: str | None = None,
                    authorization: str | None = Header(default=None)):
        _auth(authorization)
        if sop_uid not in dicom_bytes:
            raise HTTPException(status_code=404, detail="instance not found")
        import io as _io

        from PIL import Image

        state["rendered_calls"] = state.get("rendered_calls", 0) + 1
        state["rendered_prebaked"] = state.get("rendered_prebaked", 0) + (
            1 if (viewport == "512x512" and quality == 80 and not window) else 0)
        buf = _io.BytesIO()
        Image.new("L", (512, 512), color=128).save(buf, format="JPEG", quality=quality or 80)
        return Response(content=buf.getvalue(), media_type="image/jpeg")

    # ── 판독/선점/주석 (Live 계약 — A StudyReport.py/StudyImage.py 재현) ──
    @app.get("/api/study/{study_idx}/report/")
    def report_get(study_idx: int, authorization: str | None = Header(default=None)):
        _auth(authorization)
        return {"status": 200, "message": "ok", "report_data": reports.get(study_idx)}

    @app.post("/api/study/{study_idx}/report/")
    def report_post(study_idx: int, body: dict,
                    authorization: str | None = Header(default=None)):
        acc = _auth(authorization)   # 인증된 A 계정 — 실제 판독의 귀속 재현
        if "report_cvr_send" not in body:
            # A 계약 재현: report_cvr_send 미전송 시 KeyError → 500
            raise HTTPException(status_code=500, detail="KeyError: report_cvr_send")
        rep = dict(reports.get(study_idx) or {"report_idx": study_idx * 1000})
        for k in ("report_status", "report_reading", "report_conclusion",
                  "report_study_comment", "report_refer_comment", "report_open_edit",
                  "report_cvr_send"):
            if body.get(k) is not None:
                rep[k] = body[k]
        rep["study_idx"] = study_idx
        # A 계약: report_create_idx None/0 이면 토큰 사용자로 세팅(실제 판독의 귀속)
        cidx = body.get("report_create_idx") or (acc or {}).get("user_idx")
        rep["report_create_idx"] = cidx
        rep["report_create_name"] = (acc or {}).get("user_name") or "Mock User"
        rep["report_update_datetime"] = "2026-07-23 12:34:56"
        if rep.get("report_status") in ("A", "RA"):
            rep["report_approve_idx"] = body.get("report_approve_idx") or (acc or {}).get("user_idx")
            rep["report_approve_name"] = (acc or {}).get("user_name") or "Mock User"
            rep["report_approve_datetime"] = "2026-07-23 12:35:00"
        reports[study_idx] = rep
        in_progress.discard(study_idx)   # 트리거: study_status ← report_status
        return {"status": 200, "message": "ok", "report_data": rep}

    @app.get("/api/study/{study_idx}/report/change_status/{report_type}")
    def change_status(study_idx: int, report_type: str,
                      authorization: str | None = Header(default=None)):
        acc = _auth(authorization)
        row = next((r for r in studies if r["study_idx"] == study_idx), None)
        if row is None:
            raise HTTPException(status_code=404, detail="study not found")
        cur = _status_of(study_idx, row.get("study_status") or "E")
        me = (acc or {}).get("user_idx", 1)   # 인증된 판독의 idx 로 선점(per-user)
        if cur == "RI" and claims.get(study_idx) not in (None, me):
            raise HTTPException(status_code=409, detail="이미 다른 판독의가 작성 중입니다")
        if report_type == "report":
            if cur in ("R", "RR", "REF", "A", "RA"):
                raise HTTPException(status_code=409, detail="이미 판독이 완료된 검사입니다")
            in_progress.add(study_idx)
            claims[study_idx] = me
        else:
            in_progress.discard(study_idx)
        return {"status": 200, "message": "ok"}

    @app.post("/api/study/")
    def study_update(body: dict, authorization: str | None = Header(default=None)):
        _auth(authorization)
        idx = body.get("study_idx")
        row = next((r for r in studies if r["study_idx"] == idx), None)
        if row is None:
            raise HTTPException(status_code=404, detail="study not found")
        for k in ("study_comment", "study_emergency", "study_description"):
            if body.get(k) is not None:
                row[k] = body[k]
        return {"status": 200, "message": "ok"}

    @app.post("/api/study/status")
    def study_status(body: dict, authorization: str | None = Header(default=None)):
        _auth(authorization)
        idx = body.get("study_idx")
        row = next((r for r in studies if r["study_idx"] == idx), None)
        if row is None:
            raise HTTPException(status_code=404, detail="study not found")
        for k in ("study_emergency", "study_status"):
            if body.get(k) is not None:
                row[k] = body[k]
        return {"status": 200, "message": "ok"}

    bookmarks: set[int] = set()

    @app.post("/api/bookMark")
    def bookmark_add(body: dict, authorization: str | None = Header(default=None)):
        _auth(authorization)
        bookmarks.add(body.get("study_idx"))
        return {"status": 200, "message": "ok"}

    @app.delete("/api/bookMark")
    def bookmark_del(body: dict, authorization: str | None = Header(default=None)):
        _auth(authorization)
        bookmarks.discard(body.get("study_idx"))
        return {"status": 200, "message": "ok"}

    @app.get("/api/study/{study_uid}/annotation")
    def annotation_get(study_uid: str, authorization: str | None = Header(default=None)):
        _auth(authorization)
        rows = [v for (uid, _), v in annotations.items() if uid == study_uid]
        return {"status": 200, "message": "ok", "data": rows}

    @app.post("/api/study/annotation/change")
    def annotation_change(body: dict, authorization: str | None = Header(default=None)):
        _auth(authorization)
        uid = body.get("study_instance_uid")
        tool = body.get("annotation_tool_name")
        val = body.get("annotation_tool_value")
        if not uid or not tool or val is None:
            raise HTTPException(status_code=422, detail="필수 필드 누락")
        annotations[(uid, tool)] = {
            "annotation_idx": len(annotations) + 1,
            "study_instance_uid": uid,
            "annotation_tool_name": tool,
            "annotation_tool_value": val,
        }
        return {"status": 200, "message": "ok",
                "annotation_data": {"config_idx": annotations[(uid, tool)]["annotation_idx"]}}

    # 테스트 훅 — 타 판독의 선점 재현(409 검증용)
    @app.post("/__test__/claim-as-other/{study_idx}")
    def claim_as_other(study_idx: int):
        in_progress.add(study_idx)
        claims[study_idx] = 999
        return {"ok": True}

    # 테스트 훅 — 토큰 강제 무효화(재로그인 검증), 상태 조회
    @app.post("/__test__/expire-token")
    def expire_token():
        state["tokens"] = {}   # 전 계정 토큰 무효화 → 다음 요청은 401→재로그인/refresh
        return {"ok": True}

    @app.get("/__test__/state")
    def test_state():
        return {"logins": state["logins"],
                "rendered_calls": state.get("rendered_calls", 0),
                "rendered_prebaked": state.get("rendered_prebaked", 0),
                "instance_calls": state.get("instance_calls", 0),
                "list_calls": state.get("list_calls", 0)}

    return app


def main() -> None:
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8014)
    parser.add_argument("--studies", type=int, default=2)
    parser.add_argument("--instances", type=int, default=3)
    args = parser.parse_args()
    app = build_app(num_studies=args.studies, instances_per_study=args.instances)
    print(f"mock webpacs_api :{args.port} (계정 {MOCK_USER}/{MOCK_PASSWORD}, "
          f"검사 {args.studies}건 × {args.instances}장)")
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
