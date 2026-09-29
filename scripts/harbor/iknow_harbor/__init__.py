"""Harbor adapter package for the iknow CLI.

`--agent iknow_harbor.agent:IKnowAgent` and `--agent iknow_harbor:IKnowAgent`
both resolve; the re-export exists so the shorter form works in job configs.
"""

from .agent import IKnowAgent

__all__ = ["IKnowAgent"]
