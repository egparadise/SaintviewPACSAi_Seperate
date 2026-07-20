"""backup_jobs — 34차 (서버 관리 2단계: 저장공간·백업·압축)

Revision ID: c2d3e4f5a6b7
Revises: b1c2d3e4f5a6
Create Date: 2026-06-13
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c2d3e4f5a6b7"
down_revision: Union[str, Sequence[str], None] = "b1c2d3e4f5a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "backup_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False, server_default="manual"),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("compression", sa.String(24), nullable=False, server_default="none"),
        sa.Column("target_dir", sa.String(512), nullable=False, server_default=""),
        sa.Column("date_from", sa.String(8), nullable=False, server_default=""),
        sa.Column("date_to", sa.String(8), nullable=False, server_default=""),
        sa.Column("study_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("instance_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=False, server_default=""),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_backup_jobs_status", "backup_jobs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_backup_jobs_status", "backup_jobs")
    op.drop_table("backup_jobs")
