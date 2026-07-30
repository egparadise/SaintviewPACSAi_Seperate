"""studies.protocol_name/procedure_code/step_desc — 행잉 프로토콜 부위 출처(사양 ③)

행잉 프로토콜이 '부위' 를 찾을 DICOM 출처를 사용자가 고를 수 있어야 한다는 요구에서 나왔다.
사양이 이름 댄 Protocol Code · Procedure Code · Procedure Step Description 은 전부 **시리즈
레벨** 태그라 지금까지 저장되지 않았다. body_part(0018,0015) 도 같은 이유로 항상 비어 있었다.

Revision ID: a1b2c3d4e5f6
Revises: f5b6c7d8e9a0
Create Date: 2026-07-30
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "f5b6c7d8e9a0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("studies", sa.Column("protocol_name", sa.String(128), nullable=False, server_default=""))
    op.add_column("studies", sa.Column("procedure_code", sa.String(64), nullable=False, server_default=""))
    op.add_column("studies", sa.Column("step_desc", sa.String(256), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("studies", "step_desc")
    op.drop_column("studies", "procedure_code")
    op.drop_column("studies", "protocol_name")
