"""ORM 모델 — 설계 문서 §5 데이터 모델 1:1 구현.

벡터 컬럼(D-1): PostgreSQL이면 pgvector, SQLite(개발)면 JSON 직렬화 폴백.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.config import get_settings
from app.db import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _vector_type():
    settings = get_settings()
    if settings.is_postgres:
        from pgvector.sqlalchemy import Vector

        return Vector(settings.embedding_dim)
    return JSON  # SQLite 폴백: list[float] JSON 저장, 검색은 인메모리(numpy)


class Patient(Base):
    __tablename__ = "patients"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_key: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    # 화면분석 §5.5 Patient ID Prefix → issuer 분리 (P2 대비)
    issuer: Mapped[str] = mapped_column(String(64), default="")
    name_masked: Mapped[str] = mapped_column(String(128), default="")
    birth_date: Mapped[str] = mapped_column(String(8), default="")  # YYYYMMDD
    sex: Mapped[str] = mapped_column(String(8), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    studies: Mapped[list["Study"]] = relationship(back_populates="patient")


class Study(Base):
    __tablename__ = "studies"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    study_uid: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    accession_no: Mapped[str] = mapped_column(String(64), default="", index=True)
    study_date: Mapped[str] = mapped_column(String(8), default="", index=True)
    study_time: Mapped[str] = mapped_column(String(16), default="")
    modality: Mapped[str] = mapped_column(String(16), default="", index=True)
    body_part: Mapped[str] = mapped_column(String(64), default="", index=True)
    study_desc: Mapped[str] = mapped_column(String(256), default="")
    clinical_info: Mapped[str] = mapped_column(Text, default="")
    # DICOM 헤더 기반 조회 컬럼 (UBPACS-Z Filter Setting — InstitutionName/ReferringPhysicianName)
    institution: Mapped[str] = mapped_column(String(128), default="")
    referring_physician: Mapped[str] = mapped_column(String(128), default="")
    memo: Mapped[str] = mapped_column(Text, default="")  # MEMO window (사용자 메모)
    department: Mapped[str] = mapped_column(String(64), default="")   # DEPT (InstitutionalDepartmentName)
    source_aet: Mapped[str] = mapped_column(String(32), default="")   # AETITLE (수신 RemoteAET)
    bookmark: Mapped[bool] = mapped_column(Boolean, default=False)    # BOOKMARK (★)
    orthanc_id: Mapped[str] = mapped_column(String(64), default="")
    # 경량 테넌시 — 수신 AET→Modality→Hospital로 자동 귀속(없으면 NULL=전역)
    hospital_id: Mapped[int | None] = mapped_column(
        ForeignKey("hospitals.id"), nullable=True, index=True
    )
    # 워크플로 상태 (디자인 §1.1 상태 토큰과 1:1)
    status: Mapped[str] = mapped_column(
        String(16), default="received", index=True
    )  # received | draft_ready | reading | finalized
    emergency: Mapped[bool] = mapped_column(Boolean, default=False)  # F-15
    # F-16: 키이미지 선택 [{"sop_uid", "orthanc_id", "instance_number"}]
    key_images: Mapped[list] = mapped_column(JSON, default=list)
    series_count: Mapped[int] = mapped_column(Integer, default=0)
    instance_count: Mapped[int] = mapped_column(Integer, default=0)
    # QC — 환자 병합/판독 잠금. merged_from: 병합으로 이동된 검사가 가리키는 patient_merges.id
    # (기존 행은 ALTER 추가로 NULL — 소비처는 bool 강제 변환할 것)
    merged_from: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    report_locked: Mapped[bool] = mapped_column(Boolean, default=False)  # 판독 확정(잠금) — 변경 금지
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    patient: Mapped[Patient] = relationship(back_populates="studies")
    series: Mapped[list["Series"]] = relationship(back_populates="study")
    reports: Mapped[list["Report"]] = relationship(back_populates="study")


class Series(Base):
    __tablename__ = "series"

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id"), index=True)
    series_uid: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    modality: Mapped[str] = mapped_column(String(16), default="")
    series_desc: Mapped[str] = mapped_column(String(256), default="")
    series_number: Mapped[int] = mapped_column(Integer, default=0)  # Exam Control 트리 정렬
    instance_count: Mapped[int] = mapped_column(Integer, default=0)
    # Exam Control 소프트 삭제(휴지통) — NULL=정상. 삭제 시리즈는 일반 트리/뷰어에서 제외
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    study: Mapped[Study] = relationship(back_populates="series")
    instances: Mapped[list["Instance"]] = relationship(back_populates="series")


class Instance(Base):
    """이미지(SOP 인스턴스) — 앱 DB 트리. Exam Control 소프트 삭제·재귀속(검사 이동)의 단위.

    Orthanc 물리 저장·DICOM 태그는 불변이고, 귀속(series_id→study)·삭제 상태만
    앱 DB에서 관리한다(뷰어/워크리스트는 이 트리를 따른다). 행은 Exam Control 진입 시
    Orthanc 트리에서 구체화(materialize)되며, 행이 없는 인스턴스는 물리 트리 그대로다.
    """

    __tablename__ = "instances"

    id: Mapped[int] = mapped_column(primary_key=True)
    series_id: Mapped[int] = mapped_column(ForeignKey("series.id"), index=True)
    sop_uid: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    instance_number: Mapped[int] = mapped_column(Integer, default=0)
    rows: Mapped[int] = mapped_column(Integer, default=0)
    cols: Mapped[int] = mapped_column(Integer, default=0)
    orthanc_id: Mapped[str] = mapped_column(String(64), default="", index=True)  # 프리뷰/파일 접근용
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    series: Mapped[Series] = relationship(back_populates="instances")


class Report(Base):
    """판독 — 버전 행 보존(초안→수정→확정 모두 행으로 남김, 설계 §5)."""

    __tablename__ = "reports"
    __table_args__ = (UniqueConstraint("study_id", "version", name="uq_report_study_version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id"), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(
        String(16), default="draft", index=True
    )  # draft | in_review | finalized | rejected
    sr_json: Mapped[dict] = mapped_column(JSON, default=dict)  # 설계 §6.2 스키마
    narrative_text: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(64), default="ai")  # 'ai' | username
    reviewed_by: Mapped[str] = mapped_column(String(64), default="")
    finalized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ai_model: Mapped[str] = mapped_column(String(64), default="")
    ai_sources: Mapped[dict] = mapped_column(JSON, default=dict)  # 근거 추적(§4.4)
    # F-20: AI 초안 vs 확정 불일치 지표
    diff_metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    study: Mapped[Study] = relationship(back_populates="reports")


class ReportEmbedding(Base):
    __tablename__ = "report_embeddings"

    id: Mapped[int] = mapped_column(primary_key=True)
    report_id: Mapped[int] = mapped_column(ForeignKey("reports.id"), index=True)
    chunk_seq: Mapped[int] = mapped_column(Integer, default=0)
    section: Mapped[str] = mapped_column(String(32), default="full")  # full|findings|impression
    embedding = mapped_column(_vector_type())
    chunk_text: Mapped[str] = mapped_column(Text, default="")
    # 검색 1차 필터 축 (화면분석 §5.6: Modality × BodyPart)
    modality: Mapped[str] = mapped_column(String(16), default="", index=True)
    body_part: Mapped[str] = mapped_column(String(64), default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    algo: Mapped[str] = mapped_column(String(16), default="argon2")
    # 역할(권한) — admin | doctor | radiologist | technologist | staff (app.services.permissions.ROLES)
    role: Mapped[str] = mapped_column(String(16), default="radiologist")
    # 가입자 병원 소속(경량 테넌시) — NULL=전역(관리자/공용)
    hospital_id: Mapped[int | None] = mapped_column(
        ForeignKey("hospitals.id"), nullable=True, index=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)  # 비활성 계정은 로그인 거부
    email: Mapped[str] = mapped_column(String(128), default="")
    # 가입자 등록 정보 (가입 폼) — 주민번호는 앞 6자리(생년월일)만, 전체 저장 금지
    title: Mapped[str] = mapped_column(String(64), default="")   # 직책
    sex: Mapped[str] = mapped_column(String(8), default="")
    birth6: Mapped[str] = mapped_column(String(6), default="")   # 주민번호 앞 6자리(YYMMDD)
    phone: Mapped[str] = mapped_column(String(32), default="")
    mobile: Mapped[str] = mapped_column(String(32), default="")
    # 판독 서명(Reading) — 확정 시 리포트에 이름·면허번호가 함께 기록된다
    display_name: Mapped[str] = mapped_column(String(64), default="")
    license_no: Mapped[str] = mapped_column(String(32), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # ── 비밀번호 라이프사이클(발급 계정) ──
    must_change: Mapped[bool] = mapped_column(Boolean, default=False)   # 최초 로그인 시 비번 1회 강제 변경
    # ⚠ 보안 절충: admin 의 비번 조회/리셋을 위해 현재 비번을 복원 가능한 형태로 별도 저장(해시와 병행).
    #    발급(좌석) 계정 운영 요구로 명시 채택 — 인증 자체는 여전히 password_hash(argon2)로만 수행.
    pw_plain: Mapped[str] = mapped_column(String(128), default="")
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id"), nullable=True, index=True)  # 발급 좌석 연동


class Phrase(Base):
    """상용구(Predefined Readings) — Modality×BodyPart 축 + 단축키 (화면분석 §5.6, DB 정식 테이블)."""

    __tablename__ = "phrases"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    text: Mapped[str] = mapped_column(Text, default="")
    modality: Mapped[str] = mapped_column(String(16), default="", index=True)   # 빈값=공통
    body_part: Mapped[str] = mapped_column(String(64), default="", index=True)  # 빈값=공통
    category: Mapped[str] = mapped_column(String(64), default="")               # 분류(자동: MOD-부위)
    shortcut: Mapped[str] = mapped_column(String(8), default="")                # Alt+키 (한 글자/숫자)
    kind: Mapped[str] = mapped_column(String(16), default="phrase")             # phrase(단축키) | template(템플릿)
    reading_text: Mapped[str] = mapped_column(Text, default="")                 # 판독(Reading) 본문 — text는 결론
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    target_type: Mapped[str] = mapped_column(String(32), default="")
    target_id: Mapped[str] = mapped_column(String(64), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)


class AiJob(Base):
    __tablename__ = "ai_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id"), index=True)
    kind: Mapped[str] = mapped_column(String(32), default="draft")  # draft | regenerate
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    # queued | running | done | failed
    error: Mapped[str] = mapped_column(Text, default="")
    cost_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    latency_sec: Mapped[float] = mapped_column(Float, default=0.0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Annotation(Base):
    """주석/계측 (07 A.4) — 이미지 정규화 좌표(0~1) 기반, GSPS 내보내기 원천."""

    __tablename__ = "annotations"

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(ForeignKey("studies.id"), index=True)
    series_uid: Mapped[str] = mapped_column(String(128), default="")
    sop_uid: Mapped[str] = mapped_column(String(128), default="", index=True)
    kind: Mapped[str] = mapped_column(String(32), default="line")  # length|angle|rect|ellipse|arrow|text|ctr...
    points: Mapped[list] = mapped_column(JSON, default=list)  # [[x,y], ...] 0~1 정규화
    value: Mapped[float | None] = mapped_column(Float, nullable=True)
    unit: Mapped[str] = mapped_column(String(16), default="")  # mm|deg|ratio|mm2|px
    text: Mapped[str] = mapped_column(String(512), default="")
    source: Mapped[str] = mapped_column(String(16), default="user")  # user | ai
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)  # ai일 때
    verified: Mapped[bool] = mapped_column(Boolean, default=False)  # numeric_verify 결과
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Order(Base):
    """오더/예약 (RIS — P2) — MWL 항목 원천 + MPPS 상태 매핑."""

    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    patient_key: Mapped[str] = mapped_column(String(128), index=True)
    patient_name: Mapped[str] = mapped_column(String(128), default="")
    birth_date: Mapped[str] = mapped_column(String(8), default="")
    sex: Mapped[str] = mapped_column(String(8), default="")
    accession_no: Mapped[str] = mapped_column(String(64), default="", index=True)
    modality: Mapped[str] = mapped_column(String(16), default="")
    scheduled_date: Mapped[str] = mapped_column(String(8), default="", index=True)  # YYYYMMDD
    scheduled_time: Mapped[str] = mapped_column(String(6), default="")  # HHMMSS
    procedure_desc: Mapped[str] = mapped_column(String(256), default="")
    station_aet: Mapped[str] = mapped_column(String(32), default="")
    # 장비 MWL 질의에 필요한 추가 속성 (UBPACS 오더 등록 폼)
    body_part: Mapped[str] = mapped_column(String(64), default="")
    projection: Mapped[str] = mapped_column(String(32), default="")  # PA/AP/LAT 등
    dicom_study_id: Mapped[str] = mapped_column(String(16), default="")  # DICOM StudyID (0020,0010)
    # 의뢰의/진료과 (RIS 오더 입력) — MWL ReferringPhysicianName(0008,0090)·부서(0008,1040) 노출
    physician: Mapped[str] = mapped_column(String(64), default="")
    department: Mapped[str] = mapped_column(String(64), default="")
    # MPPS 매핑: scheduled(예약) → in_progress(IN PROGRESS) → completed(COMPLETED) | cancelled(DISCONTINUED)
    status: Mapped[str] = mapped_column(String(16), default="scheduled", index=True)
    # 장비 가져감 관찰 — MWL C-FIND 응답 시 호출 AET/시각 기록(상태 불변, 재질의 시 갱신)
    taken_aet: Mapped[str] = mapped_column(String(32), default="")
    taken_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 경량 테넌시 — HL7 ORM/가상환자 생성기 오더의 병원 귀속(MWL 병원 필터). NULL=전역
    hospital_id: Mapped[int | None] = mapped_column(
        ForeignKey("hospitals.id"), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Hospital(Base):
    """가입자 병원(다기관) — 경량 테넌시. 계정·검사를 hospital_id로 귀속한다."""

    __tablename__ = "hospitals"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)  # 병원 식별 코드
    name: Mapped[str] = mapped_column(String(128), default="")
    ae_title: Mapped[str] = mapped_column(String(32), default="")  # 병원 대표 AET(수신 식별 보조)
    zip: Mapped[str] = mapped_column(String(8), default="")            # 우편번호(주소 검색)
    address: Mapped[str] = mapped_column(String(256), default="")       # 도로명/지번 주소
    address_detail: Mapped[str] = mapped_column(String(256), default="")  # 상세주소(직접 입력)
    phone: Mapped[str] = mapped_column(String(64), default="")
    fax: Mapped[str] = mapped_column(String(64), default="")
    homepage: Mapped[str] = mapped_column(String(256), default="")
    departments: Mapped[str] = mapped_column(String(256), default="")  # 진료과(콤마 구분)
    contact: Mapped[str] = mapped_column(String(128), default="")  # 담당자
    max_accounts: Mapped[int] = mapped_column(Integer, default=0)   # 라이선스 계정 수(0=무제한)
    license_clients: Mapped[int] = mapped_column(Integer, default=0)  # Client(뷰어) 라이선스 수
    modality_limit: Mapped[int] = mapped_column(Integer, default=0)   # 연결할 Modality 수(0=무제한)
    # 결재(가입) — 카드 전체번호 저장 금지, 마지막 4자리만
    billing_method: Mapped[str] = mapped_column(String(24), default="")  # monthly_transfer | card
    billing_card_last4: Mapped[str] = mapped_column(String(4), default="")
    # 병원별 DICOM 네트워크 — 병원마다 포트가 달라야(서버가 병원을 구분)
    server_host: Mapped[str] = mapped_column(String(128), default="")    # 서버 IP/호스트(공유)
    scp_aet: Mapped[str] = mapped_column(String(32), default="")         # Modality 수신 Called AE
    scp_port: Mapped[int] = mapped_column(Integer, default=0)            # Modality C-STORE 수신 포트(병원별 상이)
    qr_aet: Mapped[str] = mapped_column(String(32), default="")          # Client Viewer 조회(Q/R) AE
    qr_port: Mapped[int] = mapped_column(Integer, default=0)             # Client Viewer 접속 포트(병원별 상이)
    enforce_isolation: Mapped[bool] = mapped_column(Boolean, default=False)  # 소속 계정은 자기 병원 검사만
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Modality(Base):
    """등록 장비(SCU/SCP) — Name·AET·IP·Port 관리. 등록 장비만 수신 허용(allow_receive)."""

    __tablename__ = "modalities"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int | None] = mapped_column(
        ForeignKey("hospitals.id"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # Orthanc modality 이름 = 표시명
    ae_title: Mapped[str] = mapped_column(String(32), default="", index=True)
    host: Mapped[str] = mapped_column(String(128), default="")  # IP/호스트
    port: Mapped[int] = mapped_column(Integer, default=104)
    modality_type: Mapped[str] = mapped_column(String(16), default="")  # CT|MR|CR|DX|US|...
    role: Mapped[str] = mapped_column(String(8), default="scu")          # scu | scp | both
    manufacturer: Mapped[str] = mapped_column(String(64), default="")
    allow_receive: Mapped[bool] = mapped_column(Boolean, default=True)   # 이 장비로부터 C-STORE 수신 허용
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Client(Base):
    """병원 Client(뷰어 좌석) — 라이선스 수만큼. 접속 상태(online)는 last_seen으로 판정."""

    __tablename__ = "clients"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int] = mapped_column(ForeignKey("hospitals.id"), index=True)
    name: Mapped[str] = mapped_column(String(64), default="")        # 좌석/워크스테이션 이름
    code: Mapped[str] = mapped_column(String(32), default="")        # 식별 코드(자동)
    location: Mapped[str] = mapped_column(String(128), default="")   # 설치 위치(판독실 등)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_user: Mapped[str] = mapped_column(String(64), default="")   # 마지막 접속 사용자
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class BackupJob(Base):
    """백업 작업 이력 — 설정 기간 데이터 백업 + 압축(JPEG/JPEG2000 등)."""

    __tablename__ = "backup_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), default="manual")   # manual | scheduled
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    # queued | running | done | failed
    compression: Mapped[str] = mapped_column(String(24), default="none")  # backup_service.TRANSFER_SYNTAX 키
    target_dir: Mapped[str] = mapped_column(String(512), default="")
    date_from: Mapped[str] = mapped_column(String(8), default="")  # YYYYMMDD (검사일 범위)
    date_to: Mapped[str] = mapped_column(String(8), default="")
    study_count: Mapped[int] = mapped_column(Integer, default=0)
    instance_count: Mapped[int] = mapped_column(Integer, default=0)
    total_bytes: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Hl7Inbox(Base):
    """HL7 수신함(중간 테이블) — ADT(환자 캐시)·ORM(오더 생성)·원격판독 수신 이력.

    ADT^A04/A08 은 parsed_json 에 환자 정보를 캐시하고(뷰어 patient_key 매핑 보강),
    ORM^O01 은 Order 행을 생성한다. status: received | done | error.
    """

    __tablename__ = "hl7_inbox"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int | None] = mapped_column(
        ForeignKey("hospitals.id"), nullable=True, index=True
    )
    direction: Mapped[str] = mapped_column(String(8), default="in")
    msg_type: Mapped[str] = mapped_column(String(16), default="", index=True)  # ADT^A04 등
    patient_id: Mapped[str] = mapped_column(String(64), default="", index=True)  # PID-3
    accession: Mapped[str] = mapped_column(String(64), default="", index=True)
    raw: Mapped[str] = mapped_column(Text, default="")
    parsed_json: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="received", index=True)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Hl7Outbox(Base):
    """HL7 발신함 — 판독 확정(finalize) 시 ORU^R01 적재 → MLLP 클라이언트 전송.

    status: queued | sent | error. 전송 실패 시 retry_count 증가 후 재시도 대상 유지.
    """

    __tablename__ = "hl7_outbox"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int | None] = mapped_column(
        ForeignKey("hospitals.id"), nullable=True, index=True
    )
    direction: Mapped[str] = mapped_column(String(8), default="out")
    msg_type: Mapped[str] = mapped_column(String(16), default="ORU^R01", index=True)
    patient_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    accession: Mapped[str] = mapped_column(String(64), default="", index=True)
    raw: Mapped[str] = mapped_column(Text, default="")
    parsed_json: Mapped[dict] = mapped_column(JSON, default=dict)  # {report_id, study_id …}
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    error: Mapped[str] = mapped_column(Text, default="")
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AppSetting(Base):
    """설정 — 화면분석 §5.7 교훈 5: scope 오버라이드(global → source → user)."""

    __tablename__ = "app_setting"
    __table_args__ = (UniqueConstraint("scope", "scope_id", "key", name="uq_setting_scope_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(16), default="global")  # global | source | user
    scope_id: Mapped[str] = mapped_column(String(64), default="")
    key: Mapped[str] = mapped_column(String(128), index=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class PatientMerge(Base):
    """환자 병합(Merge) 기록 — Exam Control QC.

    Master/Slave 환자를 지정해 Slave 의 전 검사를 Master 환자로 귀속한다
    (앱 DB 계층만 — Orthanc 원본·DICOM 태그 불변, examctl assign 과 동일 원칙).
    이동된 검사에는 Study.merged_from=이 행 id 가 찍히고, 워크리스트/Exam Control 은
    병합 아이콘을 표시한다. Unmerge 시 moved_study_ids 를 slave 환자로 원복한다.
    """

    __tablename__ = "patient_merges"

    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int | None] = mapped_column(
        ForeignKey("hospitals.id"), nullable=True, index=True
    )
    master_patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    slave_patient_id: Mapped[int] = mapped_column(ForeignKey("patients.id"), index=True)
    # Unmerge 원복용: 이동한 slave 검사 id 목록 + 표시용 환자 스냅샷
    moved_study_ids: Mapped[list] = mapped_column(JSON, default=list)
    master_info: Mapped[dict] = mapped_column(JSON, default=dict)  # {patient_key, patient_name, sex, birth_date}
    slave_info: Mapped[dict] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StudyActivity(Base):
    """검사 활동 하트비트 — 뷰어 열림(viewer)/판독창 작업(report) 실시간 신호.

    (study_id, kind, username) 당 1행 upsert. TTL(120s) 내 last_seen 이면 활성으로 본다.
    typing=True 는 판독문 입력 진행 중(최근 키 입력, TTL 90s). 워크리스트 read_state
    (unread/open/reading/read/fixed) 계산의 실시간 근거.
    """

    __tablename__ = "study_activity"
    __table_args__ = (
        UniqueConstraint("study_id", "kind", "username", name="uq_activity_study_kind_user"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    study_id: Mapped[int] = mapped_column(Integer, index=True)
    kind: Mapped[str] = mapped_column(String(16), default="viewer")  # viewer | report
    username: Mapped[str] = mapped_column(String(64), default="")
    typing: Mapped[bool] = mapped_column(Boolean, default=False)
    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, index=True
    )


class ActiveSession(Base):
    """동시 로그인 추적 — (hospital_id, username) 당 활성 Client 세션.

    로그인 시 세션 등록(session_id = JWT 의 sid). 같은 (병원, 사용자)의 살아있는 세션이 있으면
    중복 로그인 프롬프트를 띄우고, '인계(force)' 시 기존 세션에 revoke_deadline(카운트다운)을 설정한다.
    기존 세션의 /auth/session-status poll 이 이를 감지해 카운트다운 후 자발적 로그아웃한다.
    TTL(SESSION_TTL) 이내 last_seen 인 세션만 '살아있음'으로 본다(하드 revoke 아님 — 뷰어 UX).
    """

    __tablename__ = "active_session"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    hospital_id: Mapped[int] = mapped_column(Integer, default=0, index=True)
    username: Mapped[str] = mapped_column(String(64), default="", index=True)
    last_seen: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, index=True
    )
    # 인계 예약 — 설정되면 해당 세션은 'revoke 대기'(신규 로그인 대상에서 제외) + 카운트다운 종료
    revoke_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoke_reason: Mapped[str] = mapped_column(String(200), default="")
