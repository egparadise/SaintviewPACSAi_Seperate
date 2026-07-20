"""26차 — phrases.kind(단축키/템플릿) + reading_text(판독 본문)

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-06-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b8c9d0e1f2a3"
down_revision: Union[str, Sequence[str], None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("phrases", sa.Column("kind", sa.String(16), nullable=False, server_default="phrase"))
    op.add_column("phrases", sa.Column("reading_text", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("phrases", "reading_text")
    op.drop_column("phrases", "kind")
