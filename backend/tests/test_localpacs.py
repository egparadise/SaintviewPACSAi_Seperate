"""Local Server 모드(/api/local) 테스트 — init 구조·합성 DICOM import·tree·rendered·삭제.

local.db 는 서버 DB와 무관한 sqlite3 독립 파일이므로, 테스트마다 루트 설정을
직접 지정해 격리한다(다른 테스트가 server.network 를 건드려도 영향 없도록).
"""
import io

import numpy as np
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from app.services.settings_service import set_setting

_CT_SOP_CLASS = "1.2.840.10008.5.1.4.1.1.2"  # CT Image Storage


def _set_root(db, path) -> None:
    set_setting(db, "server.network", {"local_share_dir": str(path)})


def _make_dicom(
    *,
    pid="P001",
    name="Hong^Gildong",
    sex="M",
    modality="CT",
    study_date="20260101",
    study_desc="CHEST CT",
    study_uid=None,
    series_uid=None,
    sop_uid=None,
    instance_number=1,
    photometric="MONOCHROME2",
    wc=None,
    ww=None,
    frames=1,
) -> bytes:
    """합성 DICOM(8x8, 16bit) 생성 — write_like_original=False 로 DICM 프리앰블 포함."""
    sop_uid = sop_uid or generate_uid()
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = _CT_SOP_CLASS
    meta.MediaStorageSOPInstanceUID = sop_uid
    meta.TransferSyntaxUID = ExplicitVRLittleEndian

    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = _CT_SOP_CLASS
    ds.SOPInstanceUID = sop_uid
    ds.PatientID = pid
    ds.PatientName = name
    ds.PatientSex = sex
    ds.Modality = modality
    ds.StudyDate = study_date
    ds.StudyDescription = study_desc
    ds.StudyInstanceUID = study_uid or generate_uid()
    ds.SeriesInstanceUID = series_uid or generate_uid()
    ds.SeriesNumber = 1
    ds.InstanceNumber = instance_number
    ds.Rows = 8
    ds.Columns = 8
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = photometric
    if wc is not None:
        ds.WindowCenter = wc
    if ww is not None:
        ds.WindowWidth = ww
    if frames > 1:
        ds.NumberOfFrames = frames
    ds.PixelData = np.tile(np.arange(64, dtype=np.uint16) * 100, frames).tobytes()
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    buf = io.BytesIO()
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


def _upload(client, auth_headers, payloads):
    files = [("files", (fn, io.BytesIO(data), "application/octet-stream")) for fn, data in payloads]
    return client.post("/api/local/import", files=files, headers=auth_headers)


def test_local_requires_auth(client):
    assert client.post("/api/local/init").status_code == 401


def test_unconfigured_returns_400(client, db, auth_headers):
    _set_root(db, "")
    r = client.post("/api/local/init", headers=auth_headers)
    assert r.status_code == 400
    assert client.get("/api/local/studies", headers=auth_headers).status_code == 400


def test_init_creates_structure(client, db, auth_headers, tmp_path):
    root = tmp_path / "share"
    _set_root(db, root)
    r = client.post("/api/local/init", headers=auth_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert (root / "DB" / "local.db").is_file()
    assert (root / "Image").is_dir() and (root / "Temp").is_dir()
    # idempotent — 재호출도 200
    assert client.post("/api/local/init", headers=auth_headers).status_code == 200


def test_import_places_files_and_registers(client, db, auth_headers, tmp_path):
    root = tmp_path / "share"
    _set_root(db, root)
    study_uid = generate_uid()
    series_uid = generate_uid()
    sop1, sop2 = generate_uid(), generate_uid()
    r = _upload(
        client,
        auth_headers,
        [
            ("a_없는확장자", _make_dicom(study_uid=study_uid, series_uid=series_uid,
                                         sop_uid=sop1, instance_number=1)),
            ("b.dcm", _make_dicom(study_uid=study_uid, series_uid=series_uid,
                                  sop_uid=sop2, instance_number=2)),
            ("notes.txt", b"this is not a dicom file at all"),  # 비DICOM 스킵
        ],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["imported"] == 2
    assert body["skipped"] == 1
    assert len(body["studies"]) == 1
    st = body["studies"][0]
    assert st["patient_name"] == "Hong^Gildong"
    assert st["modality"] == "CT"
    assert st["images"] == 2
    # 배치 경로 계약: Image\{PatientID}\{StudyDate}_{Modality}\{SOP}.dcm
    d = root / "Image" / "P001" / "20260101_CT"
    assert (d / f"{sop1}.dcm").is_file() and (d / f"{sop2}.dcm").is_file()
    # Temp 정리 확인
    assert list((root / "Temp").iterdir()) == []

    # 목록/검색
    items = client.get("/api/local/studies", headers=auth_headers).json()["items"]
    assert any(i["id"] == st["id"] for i in items)
    q = client.get("/api/local/studies", params={"q": "Gildong"}, headers=auth_headers).json()
    assert len(q["items"]) >= 1
    none = client.get("/api/local/studies", params={"q": "___없음___"}, headers=auth_headers).json()
    assert none["items"] == []

    # tree 계약
    tree = client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).json()
    assert len(tree["series"]) == 1
    se = tree["series"][0]
    assert se["series_uid"] == series_uid and se["modality"] == "CT"
    assert [i["instance_number"] for i in se["instances"]] == [1, 2]
    assert all(i["rows"] == 8 and i["cols"] == 8 for i in se["instances"])

    # rendered — PNG 매직 + wc/ww 오버라이드
    iid = se["instances"][0]["iid"]
    png = client.get(f"/api/local/instances/{iid}/rendered", headers=auth_headers)
    assert png.status_code == 200
    assert png.headers["content-type"] == "image/png"
    assert png.content[:8] == b"\x89PNG\r\n\x1a\n"
    png2 = client.get(
        f"/api/local/instances/{iid}/rendered", params={"wc": 1000, "ww": 500},
        headers=auth_headers,
    )
    assert png2.status_code == 200 and png2.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert client.get("/api/local/instances/999999/rendered", headers=auth_headers).status_code == 404


def test_missing_patient_fields_fallback_unknown(client, db, auth_headers, tmp_path):
    root = tmp_path / "share"
    _set_root(db, root)
    data = _make_dicom(pid="", study_date="", modality="MR")
    r = _upload(client, auth_headers, [("x.dcm", data)])
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1
    # PatientID/StudyDate 결측 → UNKNOWN 폴백 배치
    assert (root / "Image" / "UNKNOWN" / "UNKNOWN_MR").is_dir()


def test_filename_collision_suffix(client, db, auth_headers, tmp_path):
    root = tmp_path / "share"
    _set_root(db, root)
    sop = generate_uid()
    # 같은 SOP 파일명을 선점(다른 인스턴스가 이미 점유한 상황 재현)
    d = root / "Image" / "P001" / "20260101_CT"
    d.mkdir(parents=True)
    (d / f"{sop}.dcm").write_bytes(b"occupied")
    r = _upload(client, auth_headers, [("a.dcm", _make_dicom(sop_uid=sop))])
    assert r.status_code == 200 and r.json()["imported"] == 1
    assert (d / f"{sop}_1.dcm").is_file()  # 충돌 → 접미사
    assert (d / f"{sop}.dcm").read_bytes() == b"occupied"  # 기존 파일 보존


def test_monochrome1_and_rgb_rendered(client, db, auth_headers, tmp_path):
    root = tmp_path / "share"
    _set_root(db, root)
    mono1 = _make_dicom(photometric="MONOCHROME1", wc=3200, ww=6400)
    r = _upload(client, auth_headers, [("m1.dcm", mono1)])
    st = r.json()["studies"][0]
    tree = client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).json()
    iid = tree["series"][0]["instances"][0]["iid"]
    png = client.get(f"/api/local/instances/{iid}/rendered", headers=auth_headers)
    assert png.status_code == 200 and png.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_delete_study_removes_files_and_rows(client, db, auth_headers, tmp_path):
    root = tmp_path / "share"
    _set_root(db, root)
    sop = generate_uid()
    r = _upload(client, auth_headers, [("a.dcm", _make_dicom(sop_uid=sop))])
    st = r.json()["studies"][0]
    target = root / "Image" / "P001" / "20260101_CT" / f"{sop}.dcm"
    assert target.is_file()

    dr = client.delete(f"/api/local/studies/{st['id']}", headers=auth_headers)
    assert dr.status_code == 200, dr.text
    assert dr.json()["removed_files"] == 1
    assert not target.exists()
    # DB 행 제거 → 목록/트리에서 사라짐
    items = client.get("/api/local/studies", headers=auth_headers).json()["items"]
    assert all(i["id"] != st["id"] for i in items)
    assert client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).status_code == 404
    # 재삭제 → 404
    assert client.delete(f"/api/local/studies/{st['id']}", headers=auth_headers).status_code == 404
    # 감사 로그 기록(서버 DB)
    from sqlalchemy import select

    from app.models import AuditLog

    row = db.execute(
        select(AuditLog).where(
            AuditLog.action == "local_study_delete", AuditLog.target_id == str(st["id"])
        )
    ).scalars().first()
    assert row is not None


def _files_under(base):
    """base 하위 전체 파일 상대경로 집합 — 격리 검증용."""
    return {p.relative_to(base).as_posix() for p in base.rglob("*") if p.is_file()}


def test_path_safety_malicious_filenames(client, db, auth_headers, tmp_path):
    """① 업로드 파일명에 ..\\ ·절대경로·예약명 삽입 → Image 루트 밖 기록 불가.

    배치 경로는 파일명이 아니라 DICOM 태그(SOP/PatientID)로만 결정됨을 실증한다.
    """
    root = tmp_path / "share"
    outside = tmp_path / "outside"  # 루트 형제 — 이탈 시 흔적이 남을 위치
    outside.mkdir()
    _set_root(db, root)
    before_outside = _files_under(tmp_path) - {p for p in _files_under(tmp_path) if p.startswith("share/")}
    r = _upload(
        client,
        auth_headers,
        [
            ("..\\..\\outside\\evil.dcm", _make_dicom(pid="P900")),
            ("../../outside/evil2.dcm", _make_dicom(pid="P900")),
            ("C:\\Windows\\system32\\evil3.dcm", _make_dicom(pid="P900")),
            ("CON", _make_dicom(pid="P900")),  # Windows 예약 장치명 파일명
            ("NUL.dcm", b"not a dicom"),       # 예약명 + 비DICOM → 스킵
        ],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["imported"] == 4 and body["skipped"] == 1
    # 루트 밖(outside 등)에는 아무 파일도 생기지 않았다
    assert list(outside.iterdir()) == []
    after_outside = {p for p in _files_under(tmp_path) if not p.startswith("share/")}
    assert after_outside == before_outside
    # 배치된 파일은 전부 Image\P900\ 하위
    placed = _files_under(root / "Image")
    assert len(placed) == 4 and all(p.startswith("P900/") for p in placed)


def test_patient_id_path_chars_sanitized(client, db, auth_headers, tmp_path):
    """① PatientID 의 경로조작 문자(..\\, /, :)가 폴더명에서 무력화된다."""
    root = tmp_path / "share"
    _set_root(db, root)
    r = _upload(client, auth_headers, [("a.dcm", _make_dicom(pid="..\\..\\pwn"))])
    assert r.status_code == 200 and r.json()["imported"] == 1
    # 루트 밖 이탈 없음 — Image 하위 단일 폴더에 배치
    assert not (tmp_path / "pwn").exists()
    dirs = [d.name for d in (root / "Image").iterdir()]
    assert len(dirs) == 1
    assert "\\" not in dirs[0] and "/" not in dirs[0]
    # 렌더까지 왕복 — DB rel_path 도 루트 안
    st = r.json()["studies"][0]
    tree = client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).json()
    iid = tree["series"][0]["instances"][0]["iid"]
    png = client.get(f"/api/local/instances/{iid}/rendered", headers=auth_headers)
    assert png.status_code == 200 and png.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_reserved_device_names_in_tags(client, db, auth_headers, tmp_path):
    """① PatientID/Modality 가 Windows 예약 장치명(CON, NUL)이어도 배치 성공."""
    root = tmp_path / "share"
    _set_root(db, root)
    r = _upload(client, auth_headers, [("a.dcm", _make_dicom(pid="CON", modality="NUL"))])
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1
    dirs = [d.name for d in (root / "Image").iterdir()]
    assert dirs == ["_CON"]  # 예약명 → '_' 접두 무력화
    placed = _files_under(root / "Image")
    assert len(placed) == 1


def test_corrupt_and_empty_uploads_skip_without_crash(client, db, auth_headers, tmp_path):
    """② 0바이트·손상 DICOM·비DICOM 혼합 업로드 — 크래시 없이 스킵 카운트."""
    root = tmp_path / "share"
    _set_root(db, root)
    r = _upload(
        client,
        auth_headers,
        [
            ("empty.dcm", b""),                            # 0바이트
            ("garbage.dcm", b"\x00\x01\x02" * 100),        # 임의 바이너리
            ("half.txt", b"PK\x03\x04 not dicom either"),  # 다른 포맷 시그니처
            ("ok.dcm", _make_dicom()),                     # 정상 1건
        ],
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["imported"] == 1 and body["skipped"] == 3
    # Temp 잔여물 없음
    assert list((root / "Temp").iterdir()) == []


def test_multiframe_grayscale_rendered_first_frame(client, db, auth_headers, tmp_path):
    """④ 멀티프레임 그레이(NumberOfFrames>1, ndim==3)를 RGB 로 오판하지 않고 렌더."""
    root = tmp_path / "share"
    _set_root(db, root)
    r = _upload(client, auth_headers, [("mf.dcm", _make_dicom(frames=3))])
    st = r.json()["studies"][0]
    tree = client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).json()
    iid = tree["series"][0]["instances"][0]["iid"]
    png = client.get(f"/api/local/instances/{iid}/rendered", headers=auth_headers)
    assert png.status_code == 200, png.text
    assert png.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_rendered_ww_zero_falls_back_minmax(client, db, auth_headers, tmp_path):
    """④ ww<=0 경계값 — min-max 폴백으로 200 PNG(0 나눗셈 없음)."""
    root = tmp_path / "share"
    _set_root(db, root)
    r = _upload(client, auth_headers, [("a.dcm", _make_dicom())])
    st = r.json()["studies"][0]
    tree = client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).json()
    iid = tree["series"][0]["instances"][0]["iid"]
    for params in ({"wc": 0, "ww": 0}, {"wc": -100, "ww": -5}):
        png = client.get(f"/api/local/instances/{iid}/rendered", params=params, headers=auth_headers)
        assert png.status_code == 200 and png.content[:8] == b"\x89PNG\r\n\x1a\n"


# ════════════════════ Exam Control(로컬) — /api/local/examctl ════════════════════
def _import_series(client, auth_headers, *, pid, study_uid, series_uid, sops):
    """한 검사/시리즈에 sop 목록을 업로드하고 study dict 반환."""
    payloads = [
        (f"{n}.dcm", _make_dicom(pid=pid, study_uid=study_uid, series_uid=series_uid,
                                 sop_uid=sop, instance_number=n + 1))
        for n, sop in enumerate(sops)
    ]
    r = _upload(client, auth_headers, payloads)
    assert r.status_code == 200, r.text
    return r.json()["studies"][0]


def test_examctl_requires_auth(client):
    """미인증 401 — 전 examctl 엔드포인트."""
    assert client.get("/api/local/examctl/studies").status_code == 401
    assert client.get("/api/local/examctl/trash").status_code == 401
    assert client.post("/api/local/examctl/delete", json={}).status_code == 401
    assert client.post("/api/local/examctl/restore", json={}).status_code == 401
    assert client.post("/api/local/examctl/unassign", json={}).status_code == 401
    assert client.post(
        "/api/local/examctl/assign", json={"target_study_id": 1}
    ).status_code == 401


def test_examctl_delete_restore_roundtrip(client, db, auth_headers, tmp_path):
    """삭제→일반 목록/트리 제외·examctl 트리 플래그·휴지통→복구 왕복 + 감사 로그."""
    root = tmp_path / "share"
    _set_root(db, root)
    study_uid, series_uid = generate_uid(), generate_uid()
    sop1, sop2 = generate_uid(), generate_uid()
    st = _import_series(client, auth_headers, pid="P001", study_uid=study_uid,
                        series_uid=series_uid, sops=[sop1, sop2])

    # examctl 목록은 서버 StudyRow 동형 필드 제공 — ExamControl S/I 컬럼 소비
    rows = client.get("/api/local/examctl/studies", headers=auth_headers).json()["items"]
    me = next(i for i in rows if i["id"] == st["id"])
    assert me["series_count"] == 1 and me["instance_count"] == 2

    # 빈 선택 400 / 미존재 uid 404
    assert client.post("/api/local/examctl/delete", json={},
                       headers=auth_headers).status_code == 400
    assert client.post("/api/local/examctl/delete", json={"series_uids": ["no.such.uid"]},
                       headers=auth_headers).status_code == 404

    # 시리즈 소프트 삭제
    dr = client.post("/api/local/examctl/delete", json={"series_uids": [series_uid]},
                     headers=auth_headers)
    assert dr.status_code == 200, dr.text
    assert dr.json() == {"deleted_series": 1, "deleted_images": 2}

    # 일반 트리에서 제외 + 목록 이미지 카운트 동기(0)
    tree = client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).json()
    assert tree["series"] == []
    items = client.get("/api/local/studies", headers=auth_headers).json()["items"]
    assert next(i for i in items if i["id"] == st["id"])["images"] == 0

    # examctl 트리는 deleted 플래그로 계속 표시
    et = client.get(f"/api/local/examctl/studies/{st['id']}/tree", headers=auth_headers).json()
    assert len(et["series"]) == 1
    assert et["series"][0]["deleted"] is True
    assert [i["deleted"] for i in et["series"][0]["instances"]] == [True, True]

    # 휴지통에 시리즈로 표시
    trash = client.get("/api/local/examctl/trash", headers=auth_headers).json()["items"]
    hit = next(t for t in trash if t["kind"] == "series" and t["series_uid"] == series_uid)
    assert hit["image_count"] == 2 and hit["patient_key"] == "P001"

    # 재삭제 idempotent — 이미 삭제됨이라 카운트 0
    again = client.post("/api/local/examctl/delete", json={"series_uids": [series_uid]},
                        headers=auth_headers)
    assert again.json() == {"deleted_series": 0, "deleted_images": 0}

    # 복구 → 일반 트리/카운트/휴지통 원복
    rr = client.post("/api/local/examctl/restore", json={"series_uids": [series_uid]},
                     headers=auth_headers)
    assert rr.json() == {"restored_series": 1, "restored_images": 2}
    tree2 = client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).json()
    assert len(tree2["series"]) == 1 and len(tree2["series"][0]["instances"]) == 2
    items2 = client.get("/api/local/studies", headers=auth_headers).json()["items"]
    assert next(i for i in items2 if i["id"] == st["id"])["images"] == 2
    trash2 = client.get("/api/local/examctl/trash", headers=auth_headers).json()["items"]
    assert all(t["series_uid"] != series_uid for t in trash2)

    # 감사 로그(서버 DB) — local_examctl_delete / restore
    from sqlalchemy import select

    from app.models import AuditLog

    actions = {
        a for (a,) in db.execute(
            select(AuditLog.action).where(AuditLog.action.like("local_examctl_%"))
        ).all()
    }
    assert {"local_examctl_delete", "local_examctl_restore"} <= actions


def test_examctl_image_delete_and_restore_revives_series(client, db, auth_headers, tmp_path):
    """sop 단위 삭제 → 휴지통 kind=image, 이미지 복구는 부모 시리즈도 살린다."""
    root = tmp_path / "share"
    _set_root(db, root)
    study_uid, series_uid = generate_uid(), generate_uid()
    sop1, sop2 = generate_uid(), generate_uid()
    st = _import_series(client, auth_headers, pid="P002", study_uid=study_uid,
                        series_uid=series_uid, sops=[sop1, sop2])

    dr = client.post("/api/local/examctl/delete", json={"sop_uids": [sop1]},
                     headers=auth_headers)
    assert dr.json() == {"deleted_series": 0, "deleted_images": 1}
    tree = client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).json()
    assert [i["sop_uid"] for i in tree["series"][0]["instances"]] == [sop2]
    trash = client.get("/api/local/examctl/trash", headers=auth_headers).json()["items"]
    assert any(t["kind"] == "image" and t["sop_uid"] == sop1 for t in trash)

    # 시리즈까지 삭제 후 이미지 하나만 복구 → 부모 시리즈도 복구(가시성)
    client.post("/api/local/examctl/delete", json={"series_uids": [series_uid]},
                headers=auth_headers)
    rr = client.post("/api/local/examctl/restore", json={"sop_uids": [sop1]},
                     headers=auth_headers)
    assert rr.json() == {"restored_series": 1, "restored_images": 1}
    tree2 = client.get(f"/api/local/studies/{st['id']}/tree", headers=auth_headers).json()
    assert [i["sop_uid"] for i in tree2["series"][0]["instances"]] == [sop1]


def test_examctl_unassign_bucket_reuse(client, db, auth_headers, tmp_path):
    """unassign — 로컬 미배정 버킷 1개 생성 후 재사용, 목록에 노출."""
    root = tmp_path / "share"
    _set_root(db, root)
    se_a, se_b = generate_uid(), generate_uid()
    st_a = _import_series(client, auth_headers, pid="PA", study_uid=generate_uid(),
                          series_uid=se_a, sops=[generate_uid()])
    st_b = _import_series(client, auth_headers, pid="PB", study_uid=generate_uid(),
                          series_uid=se_b, sops=[generate_uid()])

    u1 = client.post("/api/local/examctl/unassign", json={"series_uids": [se_a]},
                     headers=auth_headers)
    assert u1.status_code == 200, u1.text
    assert u1.json()["moved"] == 1
    bucket_id = u1.json()["bucket_study_id"]

    u2 = client.post("/api/local/examctl/unassign", json={"series_uids": [se_b]},
                     headers=auth_headers)
    assert u2.json() == {"moved": 1, "bucket_study_id": bucket_id}  # 같은 버킷 재사용

    # 버킷 검사가 목록에 있고 시리즈 2개 보유, 원 검사들은 0장
    items = client.get("/api/local/studies", headers=auth_headers).json()["items"]
    bucket = next(i for i in items if i["id"] == bucket_id)
    assert bucket["patient_key"] == "UNASSIGNED" and bucket["images"] == 2
    assert next(i for i in items if i["id"] == st_a["id"])["images"] == 0
    assert next(i for i in items if i["id"] == st_b["id"])["images"] == 0
    bt = client.get(f"/api/local/studies/{bucket_id}/tree", headers=auth_headers).json()
    assert {s["series_uid"] for s in bt["series"]} == {se_a, se_b}

    # 이미 버킷 소속 항목 재-unassign → moved 0(부작용 없음)
    u3 = client.post("/api/local/examctl/unassign", json={"series_uids": [se_a]},
                     headers=auth_headers)
    assert u3.json() == {"moved": 0, "bucket_study_id": bucket_id}


def test_examctl_assign_series_sop_split_roundtrip(client, db, auth_headers, tmp_path):
    """assign — 시리즈 이동·자기자신 400·sop 분할 이동 후 왕복 시 원 시리즈 복귀."""
    root = tmp_path / "share"
    _set_root(db, root)
    se_x, se_y = generate_uid(), generate_uid()
    sop1, sop2 = generate_uid(), generate_uid()
    st_a = _import_series(client, auth_headers, pid="PA", study_uid=generate_uid(),
                          series_uid=se_x, sops=[sop1, sop2])
    st_b = _import_series(client, auth_headers, pid="PB", study_uid=generate_uid(),
                          series_uid=se_y, sops=[generate_uid()])

    # 자기 자신으로의 assign → 400
    self_r = client.post(
        "/api/local/examctl/assign",
        json={"target_study_id": st_a["id"], "series_uids": [se_x]},
        headers=auth_headers,
    )
    assert self_r.status_code == 400
    # 미존재 대상 검사 → 404
    assert client.post(
        "/api/local/examctl/assign",
        json={"target_study_id": 999999, "series_uids": [se_x]},
        headers=auth_headers,
    ).status_code == 404

    # sop 단위 이동 A→B: 분할 시리즈 '{원UID}.m{B}' 생성
    mv = client.post(
        "/api/local/examctl/assign",
        json={"target_study_id": st_b["id"], "sop_uids": [sop1]},
        headers=auth_headers,
    )
    assert mv.status_code == 200, mv.text
    assert mv.json() == {"moved": 1}
    split_uid = f"{se_x}.m{st_b['id']}"
    tb = client.get(f"/api/local/studies/{st_b['id']}/tree", headers=auth_headers).json()
    split = next(s for s in tb["series"] if s["series_uid"] == split_uid)
    assert [i["sop_uid"] for i in split["instances"]] == [sop1]
    ta = client.get(f"/api/local/studies/{st_a['id']}/tree", headers=auth_headers).json()
    assert [i["sop_uid"] for i in ta["series"][0]["instances"]] == [sop2]
    items = client.get("/api/local/studies", headers=auth_headers).json()["items"]
    assert next(i for i in items if i["id"] == st_a["id"])["images"] == 1
    assert next(i for i in items if i["id"] == st_b["id"])["images"] == 2

    # 왕복 B→A: base UID 비교로 원 시리즈(se_x)에 복귀('X.mB.mA' 증식 없음)
    back = client.post(
        "/api/local/examctl/assign",
        json={"target_study_id": st_a["id"], "sop_uids": [sop1]},
        headers=auth_headers,
    )
    assert back.json() == {"moved": 1}
    ta2 = client.get(f"/api/local/studies/{st_a['id']}/tree", headers=auth_headers).json()
    orig = next(s for s in ta2["series"] if s["series_uid"] == se_x)
    assert sorted(i["sop_uid"] for i in orig["instances"]) == sorted([sop1, sop2])
    assert all(".m" not in s["series_uid"] for s in ta2["series"])
    # 왕복이 B에 남긴 빈 분할 행은 일반(뷰어) 트리에서 숨김(서버 뷰어 오버레이 동형)
    tb_back = client.get(f"/api/local/studies/{st_b['id']}/tree", headers=auth_headers).json()
    assert split_uid not in {s["series_uid"] for s in tb_back["series"]}
    # examctl 트리에는 행이 계속 보인다(서버 examctl 트리 동형 — 관리자는 잔여 행 확인 가능)
    eb = client.get(f"/api/local/examctl/studies/{st_b['id']}/tree", headers=auth_headers).json()
    assert split_uid in {s["series_uid"] for s in eb["series"]}

    # 시리즈 단위 이동 A→B: UID 불변 재귀속
    mv2 = client.post(
        "/api/local/examctl/assign",
        json={"target_study_id": st_b["id"], "series_uids": [se_x]},
        headers=auth_headers,
    )
    assert mv2.json() == {"moved": 1}
    tb2 = client.get(f"/api/local/studies/{st_b['id']}/tree", headers=auth_headers).json()
    assert se_x in {s["series_uid"] for s in tb2["series"]}


def test_root_change_uses_that_paths_db(client, db, auth_headers, tmp_path):
    """루트 경로 변경 시 그 경로의 local.db 사용 — 서로 격리."""
    root_a = tmp_path / "a"
    root_b = tmp_path / "b"
    _set_root(db, root_a)
    _upload(client, auth_headers, [("a.dcm", _make_dicom(pid="PA"))])
    assert len(client.get("/api/local/studies", headers=auth_headers).json()["items"]) == 1
    _set_root(db, root_b)
    assert client.get("/api/local/studies", headers=auth_headers).json()["items"] == []
    _set_root(db, root_a)
    assert len(client.get("/api/local/studies", headers=auth_headers).json()["items"]) == 1
