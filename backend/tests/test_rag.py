"""RAG 검색·임베딩·SR 스키마 단위 검증."""


def test_local_embedding_deterministic():
    from app.rag.embeddings import cosine, embed

    a = embed("chest CT pneumonia 폐렴 소견")
    b = embed("chest CT pneumonia 폐렴 소견")
    assert a == b
    assert abs(cosine(a, b) - 1.0) < 1e-9


def test_local_embedding_similarity_orders():
    from app.rag.embeddings import cosine, embed

    q = embed("chest CT 폐렴 폐 침윤")
    near = embed("폐렴 의심 chest CT 침윤 소견")
    far = embed("무릎 MRI 인대 파열")
    assert cosine(q, near) > cosine(q, far)


def test_sr_schema_mock_output_valid():
    """mock 생성물이 SR_SCHEMA 필수 키를 모두 충족하는지."""
    from app.rag.generate import GenerationInput, generate_draft
    from app.rag.schemas import SR_SCHEMA

    result = generate_draft(
        GenerationInput(
            modality="CT", body_part="CHEST", study_desc="CT Chest (CE)", clinical_info="기침"
        )
    )
    sr = result.sr_json
    for key in SR_SCHEMA["required"]:
        assert key in sr, f"필수 키 누락: {key}"
    assert sr["ai_meta"]["caveats"], "초안 경고문 필수(절대 규칙 2)"


def test_mock_detects_critical():
    from app.rag.generate import GenerationInput, generate_draft
    from app.rag.schemas import has_critical

    result = generate_draft(
        GenerationInput(
            modality="CR", body_part="CHEST", study_desc="Chest PA", clinical_info="기흉 의심"
        )
    )
    assert has_critical(result.sr_json)


def test_narrative_sections():
    from app.rag.generate import GenerationInput, generate_draft
    from app.rag.schemas import narrative_from_sr

    sr = generate_draft(
        GenerationInput(modality="MR", body_part="BRAIN", study_desc="MR Brain", clinical_info="")
    ).sr_json
    text = narrative_from_sr(sr)
    assert "[Findings]" in text
    assert "[Conclusion]" in text
