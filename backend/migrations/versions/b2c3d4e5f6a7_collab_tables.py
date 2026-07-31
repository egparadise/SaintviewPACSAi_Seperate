"""협진(Co-Reading) — 친구·메신저·세션·참가자·임시 열람권 5개 테이블

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-07-31
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, Sequence[str], None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "collab_friend",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("low_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("high_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("requester_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("message", sa.String(200), nullable=False, server_default=""),
        sa.Column("blocked_by", sa.Integer(), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("low_id", "high_id", name="uq_collab_friend_pair"),
    )
    op.create_index("ix_collab_friend_low_id", "collab_friend", ["low_id"])
    op.create_index("ix_collab_friend_high_id", "collab_friend", ["high_id"])
    op.create_index("ix_collab_friend_requester_id", "collab_friend", ["requester_id"])
    op.create_index("ix_collab_friend_status", "collab_friend", ["status"])

    op.create_table(
        "collab_message",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("room_key", sa.String(96), nullable=False),
        sa.Column("sender_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False, server_default="text"),
        sa.Column("body", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
    )
    # 룸 백필은 항상 (room_key, created_at DESC) 로 읽는다 — 복합 인덱스 하나로 덮는다
    op.create_index("ix_collab_message_room_created", "collab_message", ["room_key", "created_at"])
    op.create_index("ix_collab_message_sender_id", "collab_message", ["sender_id"])

    op.create_table(
        "collab_session",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("code", sa.String(40), nullable=False),
        sa.Column("host_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("host_hospital_id", sa.Integer(), nullable=True),
        sa.Column("study_id", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("study_uid", sa.String(128), nullable=False, server_default=""),
        sa.Column("title", sa.String(256), nullable=False, server_default=""),
        sa.Column("status", sa.String(16), nullable=False, server_default="open"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_collab_session_code", "collab_session", ["code"], unique=True)
    op.create_index("ix_collab_session_host_id", "collab_session", ["host_id"])
    op.create_index("ix_collab_session_hospital", "collab_session", ["host_hospital_id"])
    op.create_index("ix_collab_session_study_id", "collab_session", ["study_id"])
    op.create_index("ix_collab_session_status", "collab_session", ["status"])

    op.create_table(
        "collab_participant",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("collab_session.id"), nullable=False),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("role", sa.String(8), nullable=False, server_default="guest"),
        sa.Column("state", sa.String(16), nullable=False, server_default="invited"),
        sa.Column("control", sa.String(16), nullable=False, server_default="none"),
        sa.Column("control_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("caps", sa.JSON(), nullable=True),
        sa.Column("invited_by", sa.Integer(), nullable=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("left_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("session_id", "account_id", name="uq_collab_participant"),
    )
    op.create_index("ix_collab_participant_session", "collab_participant", ["session_id"])
    op.create_index("ix_collab_participant_account", "collab_participant", ["account_id"])
    op.create_index("ix_collab_participant_state", "collab_participant", ["state"])

    op.create_table(
        "collab_grant",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("collab_session.id"), nullable=False),
        sa.Column("account_id", sa.Integer(), sa.ForeignKey("accounts.id"), nullable=False),
        sa.Column("study_id", sa.Integer(), nullable=False),
        sa.Column("granted_by", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("session_id", "account_id", "study_id", name="uq_collab_grant"),
    )
    # 조회 게이트(_require_study)가 매 검사 조회마다 때리는 인덱스 — (account, study) 로 바로 찍는다
    op.create_index("ix_collab_grant_account_study", "collab_grant", ["account_id", "study_id"])
    op.create_index("ix_collab_grant_session", "collab_grant", ["session_id"])


def downgrade() -> None:
    op.drop_table("collab_grant")
    op.drop_table("collab_participant")
    op.drop_table("collab_session")
    op.drop_table("collab_message")
    op.drop_table("collab_friend")
