"""병원별 DICOM 네트워크 — 포트/AET 자동 배정(병원마다 상이) + 연결 점검.

각 가입 병원은 고유한 수신(SCP)·조회(Q/R) 포트를 가져야 서버가 병원을 구분한다.
⚠ 단일 Orthanc는 DICOM 포트가 하나이므로, 실제 병원별 포트 리스닝은 인프라(병원별
Orthanc 인스턴스 또는 DICOM 라우터)가 필요하다. 여기서는 병원별 엔드포인트를
'구성'으로 관리하고 연결 점검을 제공한다(설계 의도 + 운영 배치 기준).
"""
from __future__ import annotations

# 병원별 포트 베이스(겹치지 않도록 범위 분리)
SCP_PORT_BASE = 11200   # Modality C-STORE 수신
QR_PORT_BASE = 11600    # Client Viewer 조회(Q/R)


def assign_hospital_dicom(hospital) -> None:
    """미설정 필드만 채운다(병원 id 기반으로 포트가 서로 다르게). flush 이후 호출."""
    if hospital.id is None:
        return
    if not hospital.scp_port:
        hospital.scp_port = SCP_PORT_BASE + hospital.id
    if not hospital.qr_port:
        hospital.qr_port = QR_PORT_BASE + hospital.id
    code = (hospital.code or "HOSP").upper()
    if not hospital.scp_aet:
        hospital.scp_aet = f"{code[:24]}_SCP"[:32]
    if not hospital.qr_aet:
        hospital.qr_aet = f"{code[:24]}_QR"[:32]


def test_endpoint(host: str, port: int, aet: str = "") -> dict:
    """엔드포인트 연결 점검 — TCP 연결 + (AET 있으면) DICOM C-ECHO."""
    import socket

    out: dict = {"host": host, "port": port, "aet": aet, "tcp": None, "echo": None}
    if not host or not (0 < port < 65536):
        out["detail"] = "host/port 미설정"
        return out
    # TCP
    try:
        with socket.create_connection((host, int(port)), timeout=2):
            out["tcp"] = True
    except OSError as e:
        out["tcp"] = False
        out["detail"] = f"TCP 연결 실패: {str(e)[:60]}"
        return out
    # C-ECHO (AET 지정 시)
    if aet:
        try:
            from pynetdicom import AE
            from pynetdicom.sop_class import Verification

            ae = AE(ae_title="SAINTVIEW")
            ae.add_requested_context(Verification)
            ae.acse_timeout = 4
            ae.network_timeout = 4
            assoc = ae.associate(host, int(port), ae_title=aet)
            if assoc.is_established:
                st = assoc.send_c_echo()
                assoc.release()
                out["echo"] = bool(st and getattr(st, "Status", 1) == 0)
            else:
                out["echo"] = False
                out["detail"] = "DICOM 연관(Association) 수립 실패 — AET 확인"
        except Exception as e:  # noqa: BLE001 — 점검 결과로 보고
            out["echo"] = False
            out["detail"] = f"C-ECHO 실패: {str(e)[:60]}"
    return out
