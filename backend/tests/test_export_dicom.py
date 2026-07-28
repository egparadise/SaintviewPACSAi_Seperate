"""검사 DICOM 반출(/api/export) — 경로 규칙·인증·ZIP 내용 검증.

Orthanc 왕복은 막고(_read/_cached_series_tree 대체), **우리 계약**만 본다:
  · manifest 경로가 환자/검사/시리즈로 갈라지는가
  · ZIP 이 그 경로 그대로 담기는가 (받는 쪽이 폴더째 열 수 있어야 한다)
  · 다운로드 전용 토큰 통로(?token=)가 헤더 없이도 통과하고, 잘못된 토큰은 막히는가
"""
from __future__ import annotations

import io
import zipfile

import pytest

from app.api import export_dicom as ex

# 검사 폴더에는 검사마다 유일한 꼬리표가 붙는다(같은 날·같은 모달리티 충돌 방지).
# study_uid "1.2.3.4.export" → 영숫자만 "1234export" → 뒤 8자 "34export"
EXP_DIR = "DICOM/P-EXP-01/20260727_MG_34export"


@pytest.fixture()
def study(client, auth_headers, db):
    """반출 대상 검사 1건 — Orthanc 없이 DB 행만 만든다(트리는 아래에서 대체)."""
    from app.models import Patient, Study

    pt = db.query(Patient).filter_by(patient_key="P-EXP-01").first()
    if not pt:
        pt = Patient(patient_key="P-EXP-01", name_masked="홍길동", sex="F")
        db.add(pt)
        db.commit()
        db.refresh(pt)
    st = Study(patient_id=pt.id, modality="MG", study_date="20260727",
               study_desc="유방촬영", status="received",
               study_uid="1.2.3.4.export", orthanc_id="orth-1")
    db.add(st)
    db.commit()
    db.refresh(st)
    yield st
    db.delete(st)
    db.delete(pt)
    db.commit()


@pytest.fixture()
def fake_tree(monkeypatch):
    """시리즈 트리 2시리즈 × 2장 — Orthanc 를 타지 않는다."""
    from app.api import worklist as wl

    def tree(_client, _oid):
        return [
            {"series_uid": "1.2.3.4.1", "modality": "MG", "series_desc": "R CC",
             "series_number": 1,
             "instances": [{"orthanc_id": "i1", "sop_uid": "s1", "instance_number": 1},
                           {"orthanc_id": "i2", "sop_uid": "s2", "instance_number": 2}]},
            {"series_uid": "1.2.3.4.2", "modality": "MG", "series_desc": "L CC",
             "series_number": 2,
             "instances": [{"orthanc_id": "i3", "sop_uid": "s3", "instance_number": 1}]},
        ]

    monkeypatch.setattr(wl, "_cached_series_tree", tree)
    monkeypatch.setattr(ex, "_read", lambda db, f: b"DICM-" + f["sop_uid"].encode())
    # OrthancClient() 생성만으로 접속을 시도하지 않도록 — _entries 는 인스턴스만 만든다
    return tree


def test_manifest_paths(client, auth_headers, study, fake_tree):
    r = client.get(f"/api/export/manifest?study_ids={study.id}", headers=auth_headers)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["total_files"] == 3
    paths = [f["path"] for f in d["studies"][0]["files"]]
    # 환자ID/검사일_모달리티/S시리즈/일련번호 — 받는 쪽에서 검사가 섞이지 않는다
    assert paths[0] == EXP_DIR + "/S001/000001.dcm"
    assert paths[2] == EXP_DIR + "/S002/000001.dcm"


def test_zip_contains_files(client, auth_headers, study, fake_tree):
    r = client.get(f"/api/export/package?study_ids={study.id}&format=zip", headers=auth_headers)
    assert r.status_code == 200, r.text
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert "INDEX.txt" in names
    assert EXP_DIR + "/S001/000001.dcm" in names
    assert zf.read(EXP_DIR + "/S001/000001.dcm") == b"DICM-s1"


def test_package_accepts_query_token(client, auth_headers, study, fake_tree):
    """브라우저 내려받기는 Authorization 헤더를 못 붙인다 — ?token= 이 그 통로."""
    tok = auth_headers["Authorization"].split(" ", 1)[1]
    r = client.get(f"/api/export/package?study_ids={study.id}&format=zip&token={tok}")
    assert r.status_code == 200, r.text
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist()

    # 토큰이 아예 없거나 위조면 막힌다 — 쿼리 통로가 인증 구멍이 되면 안 된다
    assert client.get(f"/api/export/package?study_ids={study.id}").status_code == 401
    assert client.get(f"/api/export/package?study_ids={study.id}&token=bogus").status_code == 401


def test_ids_validation(client, auth_headers):
    assert client.get("/api/export/manifest?study_ids=", headers=auth_headers).status_code == 400
    assert client.get("/api/export/manifest?study_ids=abc", headers=auth_headers).status_code == 400
    many = ",".join(str(i) for i in range(1, 220))
    assert client.get(f"/api/export/manifest?study_ids={many}",
                      headers=auth_headers).status_code == 400


def test_iso_image(client, auth_headers, study, fake_tree):
    """CD 굽기용 ISO — pycdlib 가 있으면 실제 이미지를 만들고, 없으면 501 로 이유를 밝힌다."""
    pycdlib = pytest.importorskip("pycdlib")
    r = client.get(f"/api/export/package?study_ids={study.id}&format=iso", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/x-iso9660-image"

    # 만든 이미지를 되읽어 확인 — 굽기 전에 내용이 실제로 들어 있어야 한다
    iso = pycdlib.PyCdlib()
    iso.open_fp(io.BytesIO(r.content))
    got = io.BytesIO()
    iso.get_file_from_iso_fp(got, joliet_path="/" + EXP_DIR + "/S001/000001.dcm")
    assert got.getvalue() == b"DICM-s1"
    iso.close()


@pytest.fixture()
def same_day_pair(client, auth_headers, db):
    """같은 환자 · 같은 날 · 같은 모달리티 검사 2건.

    드문 경우가 아니다 — 실제 워크리스트에 'DX 09:51 CHEST' 와 'DX 09:51 ABDOMEN' 이
    나란히 있었다. 예전 경로 규칙(날짜_모달리티)이면 두 검사가 같은 폴더로 떨어졌다.
    """
    from app.models import Patient, Study

    pt = db.query(Patient).filter_by(patient_key="P-DUP-02").first()
    if not pt:
        pt = Patient(patient_key="P-DUP-02", name_masked="이순기", sex="M")
        db.add(pt)
        db.commit()
        db.refresh(pt)
    made = []
    for uid, oid in (("1.2.9.same.aaaa1111", "orth-a"), ("1.2.9.same.bbbb2222", "orth-b")):
        st = Study(patient_id=pt.id, modality="DX", study_date="20260728",
                   study_desc="DX", status="received", study_uid=uid, orthanc_id=oid)
        db.add(st)
        db.commit()
        db.refresh(st)
        made.append(st)
    yield made
    for st in made:
        db.delete(st)
    db.delete(pt)
    db.commit()


@pytest.fixture()
def tree_per_study(monkeypatch):
    """검사마다 다른 SOP — 두 검사의 내용이 서로 다르다는 것을 바이트로 구분한다."""
    from app.api import worklist as wl

    def tree(_client, oid):
        tag = oid[-1]
        return [{"series_uid": f"se.{tag}", "modality": "DX", "series_desc": "ap",
                 "series_number": 1,
                 "instances": [{"orthanc_id": f"i{tag}1", "sop_uid": f"sop.{tag}.1",
                                "instance_number": 1}]}]

    monkeypatch.setattr(wl, "_cached_series_tree", tree)
    monkeypatch.setattr(ex, "_read", lambda db, f: b"BYTES-" + f["sop_uid"].encode())


def test_same_day_same_modality_paths_never_collide(client, auth_headers,
                                                    same_day_pair, tree_per_study):
    """반출 경로는 검사마다 갈라져야 한다 — 겹치면 앞 검사가 통째로 사라진다."""
    a, b = same_day_pair
    ids = f"{a.id},{b.id}"
    m = client.get(f"/api/export/manifest?study_ids={ids}", headers=auth_headers).json()
    pa = {f["path"] for f in m["studies"][0]["files"]}
    pb = {f["path"] for f in m["studies"][1]["files"]}
    assert not (pa & pb), f"경로가 겹친다: {sorted(pa & pb)}"

    r = client.get(f"/api/export/package?study_ids={ids}&format=zip", headers=auth_headers)
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = [n for n in zf.namelist() if n.endswith(".dcm")]
    assert len(names) == len(set(names)) == 2, f"ZIP 안에서 겹친다: {names}"
    # 두 검사의 내용이 **둘 다** 꺼내진다(예전에는 뒤엣것만 읽혔다)
    got = {zf.read(n) for n in names}
    assert got == {b"BYTES-sop.a.1", b"BYTES-sop.b.1"}, got


def test_iso_same_day_pair_keeps_both(client, auth_headers, same_day_pair, tree_per_study):
    """ISO 는 같은 경로에 두 번 쓰면 **바이트를 이어붙인다** — 손상된 DICOM 이 구워진다."""
    pycdlib = pytest.importorskip("pycdlib")
    a, b = same_day_pair
    r = client.get(f"/api/export/package?study_ids={a.id},{b.id}&format=iso",
                   headers=auth_headers)
    assert r.status_code == 200, r.text
    m = client.get(f"/api/export/manifest?study_ids={a.id},{b.id}", headers=auth_headers).json()
    paths = [f["path"] for st in m["studies"] for f in st["files"]]
    assert len(paths) == len(set(paths)) == 2, paths

    iso = pycdlib.PyCdlib()
    iso.open_fp(io.BytesIO(r.content))
    found = []
    for path in paths:
        buf = io.BytesIO()
        iso.get_file_from_iso_fp(buf, joliet_path="/" + path)
        found.append(buf.getvalue())
    iso.close()
    # 겹치면 Joliet 이 바이트를 이어붙인다 — 각 파일이 **딱 한 검사의 내용**이어야 한다
    assert sorted(found) == sorted([b"BYTES-sop.a.1", b"BYTES-sop.b.1"]), found


def test_zip_stays_readable_past_the_4mb_flush():
    """4MB 마다 흘려보내도 ZIP 이 온전해야 한다.

    예전 구현은 `buf.seek(0); buf.truncate(0)` 으로 되감았다. ZipFile 은 tell() 값을
    로컬 헤더 오프셋으로 중앙 디렉터리에 적으므로, 되감는 순간 그 오프셋이 어긋나
    **4MB 를 넘는 모든 반출이 깨진 ZIP** 이 됐다(6MB 내용이 22MB 로 부풀고
    BadZipFile: Bad magic number). 실제 DICOM 반출은 사실상 전부 여기 해당한다.
    """
    def gen():
        sink = ex._ZipDrain()
        with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED) as zf:
            for i in range(6):                      # 1MB × 6 = 4MB 경계를 확실히 넘긴다
                zf.writestr(f"f{i}.bin", bytes(1024 * 1024))
                if sink.pending() > 4 * 1024 * 1024:
                    yield sink.drain()
        yield sink.drain()

    data = b"".join(gen())
    # 부풀지 않아야 한다 — 되감기 버그일 때 3배 이상으로 커졌다
    assert len(data) < 7 * 1024 * 1024, f"스트림이 부풀었다: {len(data)}"

    zf = zipfile.ZipFile(io.BytesIO(data))
    assert zf.testzip() is None, "ZIP 무결성 검사 실패"
    assert zf.namelist() == [f"f{i}.bin" for i in range(6)]
    for n in zf.namelist():
        assert len(zf.read(n)) == 1024 * 1024, n
