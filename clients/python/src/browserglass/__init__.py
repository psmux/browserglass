"""``browserglass``: a Python SDK for BrowserGlass.

Drives a browser over the ``bgls.v1`` protocol, the same wire a human's
viewer and the TypeScript ``@browserglass/automation`` package speak, so
your agent's browsers go through the router instead of your process
spawning and owning Chrome, and so a person can watch or take over a live
run at any time.

    import asyncio
    from browserglass import AutomationClient, RestClient

    async def main() -> None:
        async with RestClient(base_url="https://gateway.example", token=app_token) as rest:
            acquired = await rest.acquire()
            client = await AutomationClient.connect(
                endpoint=acquired.attach.ws_url, token=acquired.attach.ticket
            )
            try:
                lease = await client.acquire_control()
                await client.navigate("https://example.com")
                await client.fill("#email", "ada@example.com")
                await lease.release()
            finally:
                await client.close()
            await rest.release(acquired.instance_id)

    asyncio.run(main())

See this package's README for a fuller runnable example, the full method
surface, and the "Not implemented yet" section naming what this build
leaves out.
"""

from .client import AutomationClient, Diagnostics, Gate, build_wait_for_text_predicate
from .core import AutomationCore
from .errors import AutomationError, AutomationErrorCode, KNOWN_CODES, RestError
from .lease import AUTOMATION_LEASE_PRIORITY, ControlLeaseHandle
from .locator.types import ClickResult, FillResult, LocatorMatch, LocatorRect, ResolveResult, SelectResult, WaitForResult
from .rest import AcquireResult, AttachInfo, AttachResult, ReleaseResult, RestClient
from .swarm import (
    BrowserSwarm,
    SwarmAcquireContext,
    SwarmAcquireResult,
    SwarmCallResult,
    SwarmMember,
    SwarmYieldEvent,
    swarm_member_subject,
)
from .transport import Transport, Welcome, WebSocketLike
from .types import (
    A11yNode,
    A11yResult,
    ActionRecord,
    ConsoleEntry,
    ControlYieldEvent,
    DiagnosticsSubscription,
    DownloadResult,
    EvaluateWorld,
    GateEnableResult,
    GateRule,
    GateVerdict,
    InFlightAction,
    InspectResult,
    LeaseMode,
    NetworkRequestEntry,
    NetworkSummaryEntry,
    PageErrorEntry,
    PreemptionRequest,
    RequestGatePausedEvent,
    ResponseBodyResult,
    RevokeReason,
    ScreenshotResult,
    StatusResult,
    UploadFileInput,
)
from .worlds import EVALUATE_OPTION_NAMES, check_world, guard_page_arguments

__version__ = "0.1.0"

__all__ = [
    "AutomationClient",
    "Diagnostics",
    "Gate",
    "build_wait_for_text_predicate",
    "AutomationCore",
    "AutomationError",
    "AutomationErrorCode",
    "KNOWN_CODES",
    "RestError",
    "AUTOMATION_LEASE_PRIORITY",
    "ControlLeaseHandle",
    "ClickResult",
    "FillResult",
    "LocatorMatch",
    "LocatorRect",
    "ResolveResult",
    "SelectResult",
    "WaitForResult",
    "AcquireResult",
    "AttachInfo",
    "AttachResult",
    "ReleaseResult",
    "RestClient",
    "BrowserSwarm",
    "SwarmAcquireContext",
    "SwarmAcquireResult",
    "SwarmCallResult",
    "SwarmMember",
    "SwarmYieldEvent",
    "swarm_member_subject",
    "Transport",
    "Welcome",
    "WebSocketLike",
    "A11yNode",
    "A11yResult",
    "ActionRecord",
    "ConsoleEntry",
    "ControlYieldEvent",
    "DiagnosticsSubscription",
    "DownloadResult",
    "EvaluateWorld",
    "EVALUATE_OPTION_NAMES",
    "check_world",
    "guard_page_arguments",
    "GateEnableResult",
    "GateRule",
    "GateVerdict",
    "InFlightAction",
    "InspectResult",
    "LeaseMode",
    "NetworkRequestEntry",
    "NetworkSummaryEntry",
    "PageErrorEntry",
    "PreemptionRequest",
    "RequestGatePausedEvent",
    "ResponseBodyResult",
    "RevokeReason",
    "ScreenshotResult",
    "StatusResult",
    "UploadFileInput",
]
