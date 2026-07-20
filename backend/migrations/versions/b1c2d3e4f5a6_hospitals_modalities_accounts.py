"""hospitals/modalities + account hospital·enabled·email + study.hospital_id — 33차 (서버 관리 1단계)

Revision ID: b1c2d3e4f5a6
Revises: b8c9d0e1f2a3
Create Date: 2026-06-13
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b1c2d3e4f5a6"
down_revision: Union[str, Sequence[str], None] = "b8c9d0e1f2a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 가입자 병원(다기관)
    op.create_table(
        "hospitals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("name", sa.String(128), nullable=False, server_default=""),
        sa.Column("ae_title", sa.String(32), nullable=False, server_default=""),
        sa.Column("address", sa.String(256), nullable=False, server_default=""),
        sa.Column("phone", sa.String(64), nullable=False, server_default=""),
        sa.Column("contact", sa.String(128), nullable=False, server_default=""),
        sa.Column("max_accounts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("enforce_isolation", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_hospitals_code", "hospitals", ["code"], unique=True)

    # 등록 장비(SCU/SCP)
    op.create_table(
        "modalities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("hospital_id", sa.Integer(), sa.ForeignKey("hospitals.id"), nullable=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("ae_title", sa.String(32), nullable=False, server_default=""),
        sa.Column("host", sa.String(128), nullable=False, server_default=""),
        sa.Column("port", sa.Integer(), nullable=False, server_default="104"),
        sa.Column("modality_type", sa.String(16), nullable=False, server_default=""),
        sa.Column("role", sa.String(8), nullable=False, server_default="scu"),
        sa.Column("manufacturer", sa.String(64), nullable=False, server_default=""),
        sa.Column("allow_receive", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("note", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_modalities_name", "modalities", ["name"], unique=True)
    op.create_index("ix_modalities_ae_title", "modalities", ["ae_title"])
    op.create_index("ix_modalities_hospital_id", "modalities", ["hospital_id"])

    # 계정 확장
    op.add_column("accounts", sa.Column("hospital_id", sa.Integer(),
                                        sa.ForeignKey("hospitals.id"), nullable=True))
    op.add_column("accounts", sa.Column("enabled", sa.Boolean(), nullable=False,
                                        server_default=sa.true()))
    op.add_column("accounts", sa.Column("email", sa.String(128), nullable=False, server_default=""))
    op.create_index("ix_accounts_hospital_id", "accounts", ["hospital_id"])

    # 검사 테넌시 태깅
    op.add_column("studies", sa.Column("hospital_id", sa.Integer(),
                                       sa.ForeignKey("hospitals.id"), nullable=True))
    op.create_index("ix_studies_hospital_id", "studies", ["hospital_id"])


def downgrade() -> None:
    op.drop_index("ix_studies_hospital_id", "studies")
    op.drop_column("studies", "hospital_id")
    op.drop_index("ix_accounts_hospital_id", "accounts")
    op.drop_column("accounts", "email")
    op.drop_column("accounts", "enabled")
    op.drop_column("accounts", "hospital_id")
    op.drop_index("ix_modalities_hospital_id", "modalities")
    op.drop_index("ix_modalities_ae_title", "modalities")
    op.drop_index("ix_modalities_name", "modalities")
    op.drop_table("modalities")
    op.drop_index("ix_hospitals_code", "hospitals")
    op.drop_table("hospitals")
