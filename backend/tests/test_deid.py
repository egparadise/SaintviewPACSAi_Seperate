"""PHI 비식별화 게이트 회귀 — 설계 §10: LLM 전송 데이터 PHI 잔존 0."""
from app.rag.deid import mask


def test_rrn_masked():
    r = mask("환자 주민번호 850101-1234567 확인")
    assert "[RRN]" in r.text
    assert "850101" not in r.text


def test_phone_email_masked():
    r = mask("연락처 010-1234-5678, 메일 foo.bar@hospital.co.kr")
    assert "[PHONE]" in r.text
    assert "[EMAIL]" in r.text
    assert "010-1234-5678" not in r.text


def test_patient_no_masked():
    r = mask("환자번호 1392686 흉부 CT")
    assert "[ID]" in r.text
    assert "1392686" not in r.text


def test_name_masked_with_known_names():
    r = mask("홍길동 환자의 흉부 X-ray", patient_names=["홍길동"])
    assert "[PATIENT]" in r.text
    assert "홍길동" not in r.text


def test_clinical_text_preserved():
    """나이·성별·의학 용어는 유지(설계 §8.1)."""
    r = mask("65세 남성, chest pain으로 내원. CT chest 시행.")
    assert "65세" in r.text
    assert "chest pain" in r.text


def test_study_date_not_masked_as_id():
    r = mask("검사일 20190222 흉부 CT")
    assert "20190222" in r.text  # YYYYMMDD는 ID 마스킹 제외
