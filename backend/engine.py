"""GWINC sweep execution for queued browser jobs."""
from __future__ import annotations

import copy
import hashlib
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np
import yaml

from .core import (
    BNSRange, MAX_SPECTRA_BYTES, Parameter, apply_parameter_overrides,
    get_model_value, is_sqz_ifo_mismatch_sweep, normalize_path, parameters_from_yaml,
    path_text, quantum_spectra, shared_range_metrics, sqz_ifo_mismatch_grid,
    sweep_arm_lengths, set_model_value,
)


ProgressCallback = Callable[[int, int, str], None]


def parse_yaml_model(yaml_text: str) -> tuple[dict[str, Any], list[Parameter]]:
    if len(yaml_text.encode("utf-8")) > 2_000_000:
        raise ValueError("YAML files larger than 2 MB are not accepted by this service.")
    try:
        data = yaml.safe_load(yaml_text)
    except yaml.YAMLError as exc:
        raise ValueError(f"Could not read YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("The YAML root must be a mapping.")
    parameters = parameters_from_yaml(data)
    if not parameters:
        raise ValueError("No finite numeric parameters were found in the YAML file.")
    return data, parameters


def _request_value(request: Any, name: str) -> Any:
    """Support both Pydantic models and plain dictionaries in tests."""
    return getattr(request, name) if hasattr(request, name) else request[name]


def _axis_values(axis: Any) -> tuple[tuple[Any, ...], np.ndarray]:
    path = normalize_path(_request_value(axis, "path"))
    lower, upper = float(_request_value(axis, "minimum")), float(_request_value(axis, "maximum"))
    points = int(_request_value(axis, "points"))
    if not np.isfinite(lower) or not np.isfinite(upper) or lower == upper:
        raise ValueError(f"{path_text(path)} needs two different finite sweep bounds.")
    if points < 2 or points > 201:
        raise ValueError("Each sweep axis needs between 2 and 201 samples.")
    return path, np.linspace(lower, upper, points, dtype=float)


def _overrides(request: Any, parameter_paths: set[tuple[Any, ...]], swept: set[tuple[Any, ...]]) -> dict[tuple[Any, ...], float]:
    overrides: dict[tuple[Any, ...], float] = {}
    for entry in (_request_value(request, "fixed_overrides") or []):
        path = normalize_path(_request_value(entry, "path"))
        value = float(_request_value(entry, "value"))
        if path not in parameter_paths:
            raise ValueError(f"{path_text(path)} is not a finite numeric YAML field.")
        if path in swept:
            continue
        if not np.isfinite(value):
            raise ValueError(f"{path_text(path)} must be finite.")
        overrides[path] = value
    return overrides


def _run_budget(budget_class: type, freq: np.ndarray, ifo: Any, output_units: str) -> tuple[np.ndarray, np.ndarray]:
    budget = budget_class(freq=freq, ifo=ifo)
    return quantum_spectra(budget.run().psd, ifo, output_units)


def compute_sweep(request: Any, is_cancelled: Callable[[], bool], progress: ProgressCallback) -> dict[str, Any]:
    """Run an isolated full sweep and retain spectra for later line requests.

    The calculation path intentionally matches the desktop app: one GWINC
    quantum budget run per grid cell plus an unchanged-YAML baseline.
    """
    yaml_text = str(_request_value(request, "yaml_text"))
    yaml_data, parameters = parse_yaml_model(yaml_text)
    parameter_paths = {parameter.path for parameter in parameters}
    x_path, xs = _axis_values(_request_value(request, "x_axis"))
    y_path, ys = _axis_values(_request_value(request, "y_axis"))
    if x_path == y_path:
        raise ValueError("Choose two different sweep parameters.")
    if x_path not in parameter_paths or y_path not in parameter_paths:
        raise ValueError("Both sweep parameters must be finite numeric fields in the uploaded YAML.")

    fmin = float(_request_value(request, "fmin_hz"))
    fmax_value = _request_value(request, "fmax_hz")
    fmax = None if fmax_value in (None, 0, 0.0) else float(fmax_value)
    frequency_points = int(_request_value(request, "frequency_points"))
    alternative_mass1 = float(_request_value(request, "alternative_mass1_msun"))
    alternative_mass2 = float(_request_value(request, "alternative_mass2_msun"))
    output_units = str(_request_value(request, "output_calibration"))
    if output_units not in {"displacement", "strain"}:
        raise ValueError("Output calibration must be displacement or strain.")

    metric, alternative_metric = shared_range_metrics(
        fmin, fmax, frequency_points, alternative_mass1, alternative_mass2
    )
    cache_bytes = len(xs) * len(ys) * len(metric.freq) * 8
    if cache_bytes > MAX_SPECTRA_BYTES:
        raise ValueError(
            f"The spectrum cache would need {cache_bytes / 1024**3:.2f} GiB. "
            "Reduce the grid or frequency points to stay within the 1 GiB cache limit."
        )
    overrides = _overrides(request, parameter_paths, {x_path, y_path})
    configured_data = apply_parameter_overrides(yaml_data, overrides)
    mismatch = None
    mismatch_info: dict[str, Any] | None = None
    if is_sqz_ifo_mismatch_sweep(x_path, y_path):
        try:
            mismatch = sqz_ifo_mismatch_grid(configured_data, x_path, y_path, xs, ys)
            mismatch_info = {
                "model": "Coherent fundamental-plus-one-HOM spatial overlap",
                "units": "%",
                "phase_convention": "IFO and SQZ mismatch phases expressed in a common OMC basis",
                "formula_fraction": "ei+es-2*ei*es-2*sqrt(ei*es*(1-ei)*(1-es))*cos(psi_s-psi_i)",
            }
        except (KeyError, AttributeError, TypeError, ValueError) as exc:
            mismatch_info = {"error": f"Cannot derive SQZ–IFO mismatch: {exc}"}

    total = len(xs) * len(ys)
    range_mpc = np.full((len(ys), len(xs)), np.nan)
    alternative_range_mpc = np.full_like(range_mpc, np.nan)
    spectra = np.full((len(ys), len(xs), len(metric.freq)), np.nan)
    baseline_asd = np.full_like(metric.freq, np.nan)
    baseline_standard = float("nan")
    baseline_alternative = float("nan")
    errors: list[dict[str, Any]] = []
    started = time.perf_counter()
    completed = 0

    try:
        import gwinc
    except ImportError as exc:
        raise RuntimeError("GWINC is not installed in this server environment.") from exc

    with tempfile.TemporaryDirectory(prefix="bns-web-") as temp_directory:
        yaml_path = Path(temp_directory) / "model.yaml"
        yaml_path.write_text(yaml_text, encoding="utf-8")
        progress(completed, total, "Loading the GWINC quantum-noise model…")
        template = gwinc.load_budget(str(yaml_path), metric.freq, bname="Quantum")
        baseline = copy.deepcopy(template.ifo)
        budget_class = type(template)
        progress(completed, total, "Calculating the unchanged YAML baseline…")
        try:
            strain_psd, asd = _run_budget(budget_class, metric.freq, copy.deepcopy(baseline), output_units)
            baseline_asd[:] = asd
            baseline_standard = metric(strain_psd)
            baseline_alternative = alternative_metric(strain_psd)
        except Exception as exc:  # Baseline errors should not discard a usable sweep.
            errors.append({"kind": "baseline", "message": f"{type(exc).__name__}: {exc}"})

        configured = apply_parameter_overrides(baseline, overrides)
        progress(completed, total, "Sweeping quantum-noise-only BNS range…")
        for iy, y_value in enumerate(ys):
            for ix, x_value in enumerate(xs):
                if is_cancelled():
                    return {
                        "cancelled": True, "completed_points": completed, "total_points": total,
                        "elapsed_s": time.perf_counter() - started,
                    }
                try:
                    ifo = copy.deepcopy(configured)
                    set_model_value(ifo, x_path, x_value)
                    set_model_value(ifo, y_path, y_value)
                    strain_psd, asd = _run_budget(budget_class, metric.freq, ifo, output_units)
                    range_mpc[iy, ix] = metric(strain_psd)
                    alternative_range_mpc[iy, ix] = alternative_metric(strain_psd)
                    spectra[iy, ix, :] = asd
                except Exception as exc:
                    errors.append({
                        "kind": "grid", "ix": ix, "iy": iy,
                        "message": f"{type(exc).__name__}: {exc}",
                    })
                completed += 1
                progress(completed, total, f"Calculated {completed:,} of {total:,} grid points")

    metadata = {
        "noise": "Quantum only; no classical noise",
        "range_convention": "Euclidean leading inspiral; 1.4+1.4 Msun; SNR 8; horizon/range=2.2648",
        "standard_range": metric.metadata(),
        "alternative_range": alternative_metric.metadata(),
        "spectra_units": "Displacement ASD [m/sqrt(Hz)]",
        "quantum_output_units": output_units,
        "strain_conversion": ("S_h = S_x / L^2 using the arm length at each point"
                              if output_units == "displacement" else "None; output is already strain PSD"),
        "frequency_points": len(metric.freq),
        "requested_fmax_hz": fmax,
        "fixed_parameter_overrides": [
            {"parameter": path_text(path), "path": list(path), "value": value}
            for path, value in overrides.items()
        ],
        "yaml_sha256": hashlib.sha256(yaml_text.encode("utf-8")).hexdigest(),
        "sqz_ifo_mismatch": mismatch_info,
    }
    return {
        "cancelled": False,
        "x": xs, "y": ys,
        "range_mpc": range_mpc,
        "alternative_range_mpc": alternative_range_mpc,
        "frequency_hz": metric.freq.copy(),
        "displacement_asd": spectra,
        "baseline_displacement_asd": baseline_asd,
        "baseline_range_mpc": baseline_standard,
        "baseline_alternative_range_mpc": baseline_alternative,
        "arm_length_m": sweep_arm_lengths(configured_data, x_path, y_path, xs, ys),
        "x_path": x_path, "y_path": y_path,
        "x_parameter": next(parameter for parameter in parameters if parameter.path == x_path).as_json(),
        "y_parameter": next(parameter for parameter in parameters if parameter.path == y_path).as_json(),
        "sqz_ifo_mismatch_percent": mismatch,
        "metadata": metadata,
        "errors": errors,
        "completed_points": completed,
        "total_points": total,
        "elapsed_s": time.perf_counter() - started,
    }


def reweight_cached_spectra(result: dict[str, Any], mass1: float, mass2: float) -> np.ndarray:
    """Reintegrate retained displacement spectra for a different binary without GWINC."""
    freq = np.asarray(result["frequency_hz"], dtype=float)
    original = result["metadata"]["standard_range"]
    requested_cap = result["metadata"].get("requested_fmax_hz")
    metric = BNSRange(
        original["fmin_hz"], requested_cap, len(freq), mass1, mass2, frequency_grid=freq
    )
    spectra = np.asarray(result["displacement_asd"], dtype=float)
    arm_length = np.asarray(result["arm_length_m"], dtype=float)
    output = np.full(spectra.shape[:2], np.nan)
    for iy in range(spectra.shape[0]):
        for ix in range(spectra.shape[1]):
            asd = spectra[iy, ix]
            length = arm_length[iy, ix]
            if np.all(np.isfinite(asd)) and length > 0:
                output[iy, ix] = metric((asd / length)**2)
    return output
