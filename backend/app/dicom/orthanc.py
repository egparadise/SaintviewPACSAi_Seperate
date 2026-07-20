"""Orthanc 클라이언트 (D-3) — DICOMweb 위임 + 메타 동기화."""
from __future__ import annotations

import logging
import threading

import httpx

from app.config import get_settings

logger = logging.getLogger("saintview.orthanc")

# 연결 풀 — base_url 별 공유 httpx.Client(keep-alive 재사용, 스레드 안전).
# 기존에는 요청마다 새 Client(새 TCP)를 만들어 프레임/열기 지연에 셋업 비용이 누적됐다.
# ⚠ 전역 자격증명 전제(모든 컨테이너가 동일 계정) — 병원별 자격증명 도입 시 풀 키에 auth 포함 필요.
_POOL: dict[str, httpx.Client] = {}
_POOL_LOCK = threading.Lock()


def _pooled_client(base_url: str, auth: tuple[str, str]) -> httpx.Client:
    with _POOL_LOCK:
        c = _POOL.get(base_url)
        if c is None or c.is_closed:
            # 상한 여유(64) — htj2k 프레임 프록시·3D 볼륨 폭주·백그라운드 프리인코딩이 같은 풀을
            # 나눠 쓰므로 낮은 상한은 PoolTimeout(500 연쇄)을 만든다
            c = httpx.Client(base_url=base_url, auth=auth, timeout=30,
                             limits=httpx.Limits(max_keepalive_connections=16, max_connections=64))
            _POOL[base_url] = c
        return c


class OrthancClient:
    def __init__(self, base_url: str | None = None) -> None:
        # base_url 미지정 = 기존 공유 Orthanc 그대로(무회귀) — 병원별 컨테이너는 명시 주입
        s = get_settings()
        self._client = _pooled_client(base_url or s.orthanc_url, (s.orthanc_user, s.orthanc_password))

    def alive(self) -> bool:
        try:
            return self._client.get("/system").status_code == 200
        except httpx.HTTPError:
            return False

    def upload_dicom(self, data: bytes) -> dict:
        """단일 DICOM 인스턴스 업로드(Orthanc REST — 하네스용)."""
        r = self._client.post("/instances", content=data)
        r.raise_for_status()
        return r.json()

    def qido_studies(self, **params) -> list[dict]:
        r = self._client.get("/dicom-web/studies", params=params)
        r.raise_for_status()
        return r.json()

    def study_metadata(self, orthanc_study_id: str) -> dict:
        # ModalitiesInStudy·부서는 requestedTags로 요청해야 채워짐
        r = self._client.get(
            f"/studies/{orthanc_study_id}",
            params={"requestedTags": "ModalitiesInStudy;InstitutionalDepartmentName"},
        )
        r.raise_for_status()
        data = r.json()
        data.setdefault("MainDicomTags", {}).update(data.get("RequestedTags", {}))
        return data

    def study_source_aet(self, orthanc_study_id: str) -> str:
        """수신 RemoteAET (AETITLE 컬럼) — 첫 인스턴스 메타데이터에서 조회."""
        try:
            r = self._client.get(f"/studies/{orthanc_study_id}/instances")
            r.raise_for_status()
            instances = r.json()
            if not instances:
                return ""
            m = self._client.get(f"/instances/{instances[0]['ID']}/metadata/RemoteAET")
            return m.text.strip() if m.status_code == 200 else ""
        except httpx.HTTPError:
            return ""

    def list_changes(self, since: int = 0, limit: int = 100) -> dict:
        """Orthanc 변경 피드 — 신규 검사 동기화(폴링)."""
        r = self._client.get("/changes", params={"since": since, "limit": limit})
        r.raise_for_status()
        return r.json()

    def series_tree(self, orthanc_study_id: str) -> list[dict]:
        """시리즈 → 인스턴스 2단 트리 — 뷰어 썸네일 + 측정/Reference line용 기하 태그.

        전 인스턴스를 requestedTags 배치 1회로 조회(기존 인스턴스별 N+1 왕복 제거 —
        실측 700+장 검사 열기 7~16s → 1~2s). 배치 실패 시 기존 인스턴스별 경로 폴백.
        """

        def _floats(v: str) -> list[float]:
            try:
                return [float(x) for x in str(v).split("\\") if x != ""]
            except ValueError:
                return []

        def _node(iid: str, itags: dict) -> dict:
            return {
                "orthanc_id": iid,
                "sop_uid": itags.get("SOPInstanceUID", ""),
                "instance_number": int(itags.get("InstanceNumber") or 0),
                # 측정(mm)·Reference line 계산용 — 없으면 빈 값(프론트에서 px 폴백)
                "rows": int(itags.get("Rows") or 0),
                "cols": int(itags.get("Columns") or 0),
                "pixel_spacing": _floats(itags.get("PixelSpacing", "")),       # [row, col] mm
                "position": _floats(itags.get("ImagePositionPatient", "")),    # [x,y,z]
                "orientation": _floats(itags.get("ImageOrientationPatient", "")),  # [rx..cz] 6개
            }

        r = self._client.get(f"/studies/{orthanc_study_id}/series")
        r.raise_for_status()
        series_list = r.json()

        # 배치: 검사 전 인스턴스 + 필요한 태그를 한 번에 (인덱스 밖 태그는 Orthanc 가 파일에서 채움)
        by_series: dict[str, list[dict]] = {}
        batch_ok = False
        try:
            ir = self._client.get(
                f"/studies/{orthanc_study_id}/instances",
                params={"requestedTags": "SOPInstanceUID;InstanceNumber;Rows;Columns;"
                                         "PixelSpacing;ImagePositionPatient;ImageOrientationPatient"},
                timeout=120,
            )
            if ir.status_code == 200:
                items = ir.json()
                # requestedTags 미지원(구버전 Orthanc)이면 기하태그가 무음 강등되므로 폴백으로
                if not items or "RequestedTags" in items[0]:
                    for inst in items:
                        itags = {**inst.get("MainDicomTags", {}), **inst.get("RequestedTags", {})}
                        by_series.setdefault(inst.get("ParentSeries", ""), []).append(
                            _node(inst["ID"], itags))
                    batch_ok = True
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            # 네트워크뿐 아니라 파싱류(JSONDecodeError=ValueError, 키 결측)도 폴백으로
            by_series = {}
            batch_ok = False
            logger.warning("series_tree 배치 조회 실패 — 인스턴스별 폴백(orthanc=%s)", orthanc_study_id)

        out = []
        for s in series_list:
            tags = s.get("MainDicomTags", {})
            if batch_ok:
                instances = by_series.get(s.get("ID", ""), [])
            else:
                # 폴백 — 기존 인스턴스별 조회(호환 유지)
                instances = []
                for iid in s.get("Instances", []):
                    fr = self._client.get(f"/instances/{iid}/tags?simplify")
                    if fr.status_code != 200:
                        continue
                    instances.append(_node(iid, fr.json()))
            instances.sort(key=lambda x: x["instance_number"])
            out.append({
                "series_uid": tags.get("SeriesInstanceUID", ""),
                "modality": tags.get("Modality", ""),
                "series_desc": tags.get("SeriesDescription", ""),
                "series_number": int(tags.get("SeriesNumber") or 0),
                "instances": instances,
            })
        out.sort(key=lambda x: x["series_number"])
        return out

    def study_instances(self, orthanc_study_id: str) -> list[dict]:
        """검사 인스턴스 목록 — 키이미지 선택 UI용(F-16)."""
        r = self._client.get(f"/studies/{orthanc_study_id}/instances")
        r.raise_for_status()
        out = []
        for inst in r.json():
            tags = inst.get("MainDicomTags", {})
            out.append({
                "orthanc_id": inst["ID"],
                "sop_uid": tags.get("SOPInstanceUID", ""),
                "instance_number": int(tags.get("InstanceNumber") or 0),
            })
        out.sort(key=lambda x: x["instance_number"])
        return out

    def instance_file(self, orthanc_instance_id: str, transcode: str | None = None) -> bytes:
        """인스턴스 DICOM 파일 — transcode 지정 시 해당 전송구문으로 변환(백업 압축).

        ⚠ 압축 코덱 플러그인이 없으면 Orthanc가 원본을 반환하거나 422를 내므로
        호출부(backup_service)에서 폴백을 처리한다.
        """
        params = {"transcode": transcode} if transcode else None
        r = self._client.get(f"/instances/{orthanc_instance_id}/file", params=params)
        r.raise_for_status()
        return r.content

    def statistics(self) -> dict:
        """Orthanc 저장 통계 — 디스크 사용량·검사/인스턴스 수(저장공간 관리)."""
        r = self._client.get("/statistics")
        r.raise_for_status()
        return r.json()

    def instance_meta(self, orthanc_instance_id: str) -> dict:
        """SOPClassUID·SeriesUID 등 — KOS 참조 무결성용."""
        r = self._client.get(f"/instances/{orthanc_instance_id}/tags?simplify")
        r.raise_for_status()
        t = r.json()
        return {
            "sop_class_uid": t.get("SOPClassUID", ""),
            "series_uid": t.get("SeriesInstanceUID", ""),
        }

    def instance_preview_png(self, orthanc_instance_id: str) -> bytes | None:
        try:
            r = self._client.get(
                f"/instances/{orthanc_instance_id}/preview", headers={"Accept": "image/png"}
            )
            r.raise_for_status()
            return r.content
        except httpx.HTTPError:
            return None

    def study_preview_png(self, orthanc_study_id: str) -> bytes | None:
        """검사 대표(중간) 인스턴스의 렌더링 PNG — vision 분석용(F-11).

        ⚠ 번인 PHI 마스킹(설계 §8.1)은 P2 — 현재는 ai.policy.vision 토글로 opt-in.
        """
        try:
            r = self._client.get(f"/studies/{orthanc_study_id}/instances")
            r.raise_for_status()
            instances = r.json()
            if not instances:
                return None
            mid = instances[len(instances) // 2]["ID"]
            r = self._client.get(f"/instances/{mid}/preview", headers={"Accept": "image/png"})
            r.raise_for_status()
            return r.content
        except httpx.HTTPError:
            return None

    def close(self) -> None:
        """no-op — 풀 공유 클라이언트는 keep-alive 유지(호출부의 기존 close 패턴과 호환)."""


def orthanc_url_for_hospital(db, hospital_id) -> str | None:
    """병원 전용 Orthanc URL 해석 — infra.containers 레지스트리에 등록돼 있으면 그 URL.

    미등록/미지정이면 None(공유 컨테이너 폴백 — 기존 동작 무회귀).
    """
    if hospital_id is None:
        return None
    try:
        from app.services.settings_service import get_setting

        reg = get_setting(db, "infra.containers", default={}) or {}
        entry = reg.get(str(hospital_id)) if isinstance(reg, dict) else None
        url = entry.get("url") if isinstance(entry, dict) else None
        return str(url) if url else None
    except Exception:  # noqa: BLE001 — 해석 실패는 공유 폴백(가용성 우선)
        logger.warning("병원별 Orthanc URL 해석 실패(hid=%s) — 공유 컨테이너 폴백", hospital_id)
        return None


def client_for_hospital(db, hospital_id) -> OrthancClient:
    """병원별 컨테이너가 있으면 그쪽, 없으면 공유 Orthanc 클라이언트(폴백)."""
    return OrthancClient(base_url=orthanc_url_for_hospital(db, hospital_id))


def sync_new_studies(db, client: OrthancClient, since: int = 0) -> tuple[int, int]:
    """Orthanc 변경 피드 → studies 테이블 동기화 + AI 작업 큐 등록.

    반환: (등록 검사 수, 마지막 change seq)
    """
    from app.config import get_settings
    from app.services.study_service import queue_ai_job, register_study

    changes = client.list_changes(since=since)
    registered = 0
    for ch in changes.get("Changes", []):
        if ch.get("ChangeType") != "StableStudy":
            continue
        meta = client.study_metadata(ch["ID"])
        tags = meta.get("MainDicomTags", {})
        ptags = meta.get("PatientMainDicomTags", {})
        study = register_study(
            db,
            study_uid=tags.get("StudyInstanceUID", ""),
            patient_key=ptags.get("PatientID", "UNKNOWN"),
            patient_name=ptags.get("PatientName", ""),
            birth_date=ptags.get("PatientBirthDate", ""),
            sex=ptags.get("PatientSex", ""),
            accession_no=tags.get("AccessionNumber", ""),
            study_date=tags.get("StudyDate", ""),
            study_time=tags.get("StudyTime", ""),
            modality=tags.get("ModalitiesInStudy", "").split("\\")[0]
            if tags.get("ModalitiesInStudy")
            else "",
            study_desc=tags.get("StudyDescription", ""),
            institution=tags.get("InstitutionName", ""),
            referring_physician=str(tags.get("ReferringPhysicianName", "")),
            department=tags.get("InstitutionalDepartmentName", ""),
            source_aet=client.study_source_aet(ch["ID"]),
            orthanc_id=ch["ID"],
        )
        if study.status == "received" and get_settings().ai_auto_generate:
            # 중복 큐잉 가드: 같은 검사에 미완료 잡이 있으면 재큐잉하지 않는다
            # (since=0 재폴링·재기동 시 잡 폭증 방지)
            from sqlalchemy import select as _select

            from app.models import AiJob

            pending = db.execute(
                _select(AiJob.id).where(
                    AiJob.study_id == study.id, AiJob.status.in_(["queued", "running"])
                ).limit(1)
            ).first()
            if not pending:
                queue_ai_job(db, study)
        registered += 1
    return registered, changes.get("Last", since)
