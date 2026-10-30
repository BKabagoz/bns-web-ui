"""FastAPI server for the browser-based quantum-noise BNS sweep application.

Run from the project directory with:

    uvicorn backend.app:app --host 127.0.0.1 --port 8000

The API serves the local frontend too, which makes the first test simple:
open http://127.0.0.1:8000 after starting the command above.  GitHub Pages
can later serve the same frontend files while this API remains on the laptop.
"""
from __future__ import annotations

import io
import json
import math
import os
import secrets
from pathlib import Path
from typing import Any, Literal

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .core import BNSRange, all_linecut_maxima, linecut_maximum, normalize_path
from .engine import parse_yaml_model, reweight_cached_spectra
from .job_queue import JobQueue, SweepJob


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ROOT = PROJECT_ROOT / "frontend"
ACCESS_TOKEN = os.getenv("BNS_ACCESS_TOKEN", "").strip()
ALLOWED_ORIGINS = [
    value.strip() for value in os.getenv(
        "BNS_ALLOWED_ORIGINS", "http://127.0.0.1:8000,http://localhost:8000"
    ).split(",") if value.strip()
]
JOBS = JobQueue()


class AxisRequest(BaseModel):
    path: list[str | int]
    minimum: float
    maximum: float
    points: int = Field(ge=2, le=201)


class OverrideRequest(BaseModel):
    path: list[str | int]
    value: float


class SweepRequest(BaseModel):
    yaml_text: str = Field(min_length=1, max_length=2_000_000)
    x_axis: AxisRequest
    y_axis: AxisRequest
    fixed_overrides: list[OverrideRequest] = Field(default_factory=list)
    fmin_hz: float = Field(default=10.0, gt=0)
    fmax_hz: float | None = Field(default=None, ge=0)
    frequency_points: int = Field(default=801, ge=2, le=4001)
    alternative_mass1_msun: float = Field(default=1.4, gt=0)
    alternative_mass2_msun: float = Field(default=1.4, gt=0)
    output_calibration: Literal["displacement", "strain"] = "displacement"


class ModelRequest(BaseModel):
    yaml_text: str = Field(min_length=1, max_length=2_000_000)


class ReweightRequest(BaseModel):
    mass1_msun: float = Field(gt=0)
    mass2_msun: float = Field(gt=0)


def _queue_snapshot(job: SweepJob) -> dict[str, Any]:
    return JOBS.snapshot(job)


def _job_or_404(job_id: str) -> SweepJob:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown calculation job.")
    return job


def _completed_result(job_id: str) -> dict[str, Any]:
    job = _job_or_404(job_id)
    if job.status != "completed" or job.result is None:
        raise HTTPException(status_code=409, detail=f"Job is {job.status}, not complete.")
    return job.result


def _clean_json(value: Any) -> Any:
    """Convert NumPy values and nonfinite cells into browser-safe JSON."""
    if isinstance(value, np.ndarray):
        return _clean_json(value.tolist())
    if isinstance(value, np.generic):
        return _clean_json(value.item())
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): _clean_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean_json(item) for item in value]
    return value


def _result_summary(result: dict[str, Any]) -> dict[str, Any]:
    """Return maps and metadata, keeping the large cached spectra on the server."""
    keys = (
        "x", "y", "range_mpc", "alternative_range_mpc", "frequency_hz",
        "baseline_range_mpc", "baseline_alternative_range_mpc", "x_parameter", "y_parameter",
        "sqz_ifo_mismatch_percent", "metadata", "errors", "completed_points", "total_points", "elapsed_s",
    )
    return _clean_json({key: result.get(key) for key in keys})


async def require_access(x_bns_access_token: str | None = Header(default=None)) -> None:
    """Optional shared token for a small trusted group.

    Leave BNS_ACCESS_TOKEN unset for local development.  A token must be
    entered manually in the browser; it is intentionally never embedded in
    the static GitHub Pages files.
    """
    if ACCESS_TOKEN and not (x_bns_access_token and secrets.compare_digest(x_bns_access_token, ACCESS_TOKEN)):
        raise HTTPException(status_code=401, detail="A valid compute-server access token is required.")


app = FastAPI(
    title="Quantum-noise-only BNS calculation service",
    version="0.1.0",
    description="Queued local GWINC calculations for the browser UI.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"https://[^/]+\.github\.io",
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-BNS-Access-Token"],
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    try:
        import gwinc
        gwinc_version: str | None = str(getattr(gwinc, "__version__", "installed"))
    except ImportError:
        gwinc_version = None
    return {
        "ok": True,
        "service": "quantum-noise-only BNS calculation server",
        "worker_concurrency": JOBS.concurrency,
        "gwinc_version": gwinc_version,
        "token_required": bool(ACCESS_TOKEN),
    }


@app.post("/api/model/parameters", dependencies=[Depends(require_access)])
async def model_parameters(model: ModelRequest) -> dict[str, Any]:
    try:
        _, parameters = parse_yaml_model(model.yaml_text)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"parameters": [parameter.as_json() for parameter in parameters]}


@app.post("/api/jobs", dependencies=[Depends(require_access)])
async def create_job(request: SweepRequest) -> dict[str, Any]:
    try:
        # Validate path forms and axis distinction before admitting a job to the queue.
        x_path, y_path = normalize_path(request.x_axis.path), normalize_path(request.y_axis.path)
        if x_path == y_path:
            raise ValueError("Choose two different sweep parameters.")
        if not math.isfinite(request.x_axis.minimum) or not math.isfinite(request.x_axis.maximum):
            raise ValueError("X sweep bounds must be finite.")
        if not math.isfinite(request.y_axis.minimum) or not math.isfinite(request.y_axis.maximum):
            raise ValueError("Y sweep bounds must be finite.")
        if request.x_axis.minimum == request.x_axis.maximum or request.y_axis.minimum == request.y_axis.maximum:
            raise ValueError("Each axis needs two different sweep bounds.")
        if request.frequency_points > 4001:
            raise ValueError("Frequency samples may not exceed 4001.")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    job = JOBS.submit(request)
    return _queue_snapshot(job)


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_access)])
async def job_status(job_id: str) -> dict[str, Any]:
    return _queue_snapshot(_job_or_404(job_id))


@app.delete("/api/jobs/{job_id}", dependencies=[Depends(require_access)])
async def cancel_job(job_id: str) -> dict[str, Any]:
    job = JOBS.cancel(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown calculation job.")
    return _queue_snapshot(job)


@app.get("/api/jobs/{job_id}/result", dependencies=[Depends(require_access)])
async def result_summary(job_id: str) -> dict[str, Any]:
    return _result_summary(_completed_result(job_id))


@app.get("/api/jobs/{job_id}/line", dependencies=[Depends(require_access)])
async def selected_line(
    job_id: str,
    orientation: Literal["horizontal", "vertical"] = "horizontal",
    index: int = Query(ge=0),
    range_kind: Literal["standard", "alternative"] = "standard",
) -> dict[str, Any]:
    result = _completed_result(job_id)
    grid = np.asarray(result["range_mpc" if range_kind == "standard" else "alternative_range_mpc"], dtype=float)
    spectra = np.asarray(result["displacement_asd"], dtype=float)
    xs, ys = np.asarray(result["x"], dtype=float), np.asarray(result["y"], dtype=float)
    horizontal = orientation == "horizontal"
    count = len(ys) if horizontal else len(xs)
    if index >= count:
        raise HTTPException(status_code=422, detail=f"Line index must be below {count}.")
    records: list[dict[str, Any]] = []
    if horizontal:
        for ix in range(len(xs)):
            asd = spectra[index, ix]
            if np.all(np.isfinite(asd)):
                records.append({"ix": ix, "iy": index, "x": xs[ix], "y": ys[index],
                                "range_mpc": grid[index, ix], "asd": asd})
        winner = linecut_maximum(grid, True, 0, index)
    else:
        for iy in range(len(ys)):
            asd = spectra[iy, index]
            if np.all(np.isfinite(asd)):
                records.append({"ix": index, "iy": iy, "x": xs[index], "y": ys[iy],
                                "range_mpc": grid[iy, index], "asd": asd})
        winner = linecut_maximum(grid, False, index, 0)
    return _clean_json({
        "orientation": orientation, "index": index, "range_kind": range_kind,
        "frequency_hz": result["frequency_hz"], "records": records,
        "winner": None if winner is None else {"ix": winner[0], "iy": winner[1]},
        "baseline_asd": result["baseline_displacement_asd"],
        "baseline_range_mpc": result["baseline_range_mpc" if range_kind == "standard"
                                     else "baseline_alternative_range_mpc"],
    })


@app.get("/api/jobs/{job_id}/winners", dependencies=[Depends(require_access)])
async def line_winners(
    job_id: str,
    orientation: Literal["horizontal", "vertical"] = "horizontal",
    range_kind: Literal["standard", "alternative"] = "standard",
    include_spectra: bool = False,
) -> dict[str, Any]:
    result = _completed_result(job_id)
    grid = np.asarray(result["range_mpc" if range_kind == "standard" else "alternative_range_mpc"], dtype=float)
    spectra = np.asarray(result["displacement_asd"], dtype=float)
    winners = all_linecut_maxima(grid, orientation == "horizontal")
    records: list[dict[str, Any]] = []
    for ix, iy in winners:
        record: dict[str, Any] = {
            "ix": int(ix), "iy": int(iy), "x": result["x"][ix], "y": result["y"][iy],
            "range_mpc": grid[iy, ix],
        }
        if include_spectra and np.all(np.isfinite(spectra[iy, ix])):
            record["asd"] = spectra[iy, ix]
        records.append(record)
    return _clean_json({"orientation": orientation, "range_kind": range_kind,
                        "frequency_hz": result["frequency_hz"], "records": records})


@app.post("/api/jobs/{job_id}/reweight", dependencies=[Depends(require_access)])
async def reweight(job_id: str, request: ReweightRequest) -> dict[str, Any]:
    result = _completed_result(job_id)
    try:
        map_mpc = reweight_cached_spectra(result, request.mass1_msun, request.mass2_msun)
        original = result["metadata"]["standard_range"]
        BNSRange(original["fmin_hz"], result["frequency_hz"][-1], len(result["frequency_hz"]),
                 request.mass1_msun, request.mass2_msun, frequency_grid=result["frequency_hz"])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _clean_json({
        "mass1_msun": request.mass1_msun, "mass2_msun": request.mass2_msun,
        "range_mpc": map_mpc,
        "message": "Reweighted cached spectra; no additional GWINC calls were made.",
    })


@app.get("/api/jobs/{job_id}/download", dependencies=[Depends(require_access)])
async def download_npz(job_id: str) -> StreamingResponse:
    result = _completed_result(job_id)
    metadata = dict(result["metadata"])
    metadata["errors"] = result["errors"]
    extra = {}
    if result.get("sqz_ifo_mismatch_percent") is not None:
        extra["sqz_ifo_mismatch_percent"] = result["sqz_ifo_mismatch_percent"]
    stream = io.BytesIO()
    np.savez_compressed(
        stream,
        x=result["x"], y=result["y"], bns_range_mpc=result["range_mpc"],
        alternative_bns_range_mpc=result["alternative_range_mpc"],
        frequency_hz=result["frequency_hz"], displacement_asd_m_per_sqrt_hz=result["displacement_asd"],
        baseline_displacement_asd_m_per_sqrt_hz=result["baseline_displacement_asd"],
        baseline_bns_range_mpc=result["baseline_range_mpc"],
        baseline_alternative_bns_range_mpc=result["baseline_alternative_range_mpc"],
        arm_length_m=result["arm_length_m"], metadata_json=np.array(json.dumps(_clean_json(metadata))), **extra,
    )
    stream.seek(0)
    return StreamingResponse(
        stream, media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="bns_sweep_{job_id[:8]}.npz"'},
    )


# This mount comes last so /api/* routes remain available when testing locally.
if FRONTEND_ROOT.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_ROOT), html=True), name="frontend")
