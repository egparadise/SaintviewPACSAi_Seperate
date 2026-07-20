"""37차 — GSPS 불러오기(타사 PR 표시): 생성→파싱 라운드트립 + PIXEL 단위 정규화."""
from __future__ import annotations

from types import SimpleNamespace

from app.dicom.gsps import (
    GSPS_SOP_CLASS,
    build_gsps_dataset,
    gsps_bytes,
    parse_gsps_dataset,
    read_gsps_bytes,
)


def test_gsps_roundtrip_display_units():
    study = SimpleNamespace(study_uid="1.2.3", accession_no="A1",
                            study_date="20240101", study_time="120000")
    patient = SimpleNamespace(patient_key="P1", name_masked="X", birth_date="", sex="M")
    images = [{"sop_uid": "sop1", "series_uid": "ser1", "rows": 512, "cols": 512}]
    annos = [
        {"kind": "length", "points": [[0.1, 0.1], [0.3, 0.3]], "sop_uid": "sop1"},
        {"kind": "rect", "points": [[0.2, 0.2], [0.5, 0.5]], "sop_uid": "sop1"},
        {"kind": "ellipse", "points": [[0.4, 0.4], [0.6, 0.6]], "sop_uid": "sop1"},
        {"kind": "text", "points": [[0.5, 0.5]], "text": "note", "sop_uid": "sop1"},
    ]
    ds = build_gsps_dataset(study=study, patient=patient, images=images,
                            annotations=annos, wc=40, ww=400, label="TEST", creator="me")
    parsed = read_gsps_bytes(gsps_bytes(ds))
    kinds = [a["kind"] for a in parsed["annotations"]]
    assert "length" in kinds and "rect" in kinds and "ellipse" in kinds and "text" in kinds
    assert parsed["wc"] == 40 and parsed["ww"] == 400
    assert parsed["label"] == "TEST"
    assert all(a["source"] == "external" for a in parsed["annotations"])
    L = next(a for a in parsed["annotations"] if a["kind"] == "length")
    assert abs(L["points"][0][0] - 0.1) < 1e-6 and abs(L["points"][1][1] - 0.3) < 1e-6


def test_gsps_pixel_units_normalized():
    """타사 PR이 PIXEL 단위면 DisplayedArea 크기로 0~1 정규화."""
    from pydicom.dataset import Dataset

    ds = Dataset()
    ds.SOPClassUID = GSPS_SOP_CLASS
    area = Dataset()
    ri = Dataset(); ri.ReferencedSOPInstanceUID = "s1"
    area.ReferencedImageSequence = [ri]
    area.DisplayedAreaBottomRightHandCorner = [512, 256]  # cols, rows
    ds.DisplayedAreaSelectionSequence = [area]
    item = Dataset()
    ri2 = Dataset(); ri2.ReferencedSOPInstanceUID = "s1"
    item.ReferencedImageSequence = [ri2]
    g = Dataset()
    g.GraphicAnnotationUnits = "PIXEL"
    g.GraphicType = "POLYLINE"
    g.NumberOfGraphicPoints = 2
    g.GraphicData = [256, 128, 256, 64]
    item.GraphicObjectSequence = [g]
    ds.GraphicAnnotationSequence = [item]

    parsed = parse_gsps_dataset(ds)
    a = parsed["annotations"][0]
    assert a["kind"] == "length"
    assert abs(a["points"][0][0] - 0.5) < 1e-6   # 256/512
    assert abs(a["points"][0][1] - 0.5) < 1e-6   # 128/256
    assert abs(a["points"][1][1] - 0.25) < 1e-6  # 64/256


def test_read_non_gsps_returns_empty():
    from pydicom.dataset import Dataset

    ds = Dataset()
    ds.SOPClassUID = "1.2.840.10008.5.1.4.1.1.2"  # CT, not GSPS
    import io

    # read_gsps_bytes는 SOPClassUID로 게이트 → 빈 주석
    from pydicom.dataset import FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid

    ds.file_meta = FileMetaDataset()
    ds.file_meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2"
    ds.file_meta.MediaStorageSOPInstanceUID = generate_uid()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.SOPInstanceUID = ds.file_meta.MediaStorageSOPInstanceUID
    buf = io.BytesIO(); ds.save_as(buf, write_like_original=False)
    assert read_gsps_bytes(buf.getvalue())["annotations"] == []
