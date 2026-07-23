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
    state = {"token": None, "logins": 0}

    # 합성 검사 데이터 — 원격 DB 행(pacs_study_view/pacs_series/pacs_image 대응) + DICOM 바이트
    studies: list[dict] = []
    series_by_study: dict[int, list[dict]] = {}
    dicom_bytes: dict[str, bytes] = {}
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

    def _auth(authorization: str | None) -> None:
        token = (authorization or "").removeprefix("Bearer ").strip()
        if not token or token != state["token"]:
            raise HTTPException(status_code=401, detail="token invalid")

    @app.post("/api/user/auth/login")
    def login(body: dict):
        if body.get("user_id") != user_id or body.get("user_passwd") != password:
            return {"status": 401, "message": "login failed", "token": None}
        state["logins"] += 1
        state["token"] = f"mock-token-{state['logins']}"
        return {
            "user_data": {"user_idx": 1, "user_id": user_id, "user_name": "Mock User",
                          "group_idx": 1, "group_level": 99},
            "token": state["token"], "refresh_token": "mock-refresh",
            "message": "user login successful", "status": 200,
        }

    @app.get("/api/study/")
    def study_list(limit: str = "300", offset: str = "0", patient_id: str | None = None,
                   patient_name: str | None = None, study_modality: str | None = None,
                   study_search: str | None = None,
                   authorization: str | None = Header(default=None)):
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
        off, lim = int(offset or 0), int(limit or 300)
        page = rows[off:off + lim]
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

    @app.get("/api/study/{study_idx}")
    def study_detail(study_idx: int, authorization: str | None = Header(default=None)):
        _auth(authorization)
        for r in studies:
            if r["study_idx"] == study_idx:
                return {"study_data": r, "message": "ok", "status": 200}
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
        return Response(content=data, media_type="application/dicom")

    # 테스트 훅 — 토큰 강제 무효화(재로그인 검증), 상태 조회
    @app.post("/__test__/expire-token")
    def expire_token():
        state["token"] = None
        return {"ok": True}

    @app.get("/__test__/state")
    def test_state():
        return {"logins": state["logins"]}

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
