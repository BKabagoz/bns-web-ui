"""Physics and model helpers shared by the browser calculation service.

This module deliberately contains no Qt code.  The BNS convention and the
quantum-PSD conversion are copied from the local desktop application so the
web service evaluates the same quantity: a quantum-noise-only, orientation-
averaged leading-inspiral BNS range.
"""
from __future__ import annotations

import copy
import numbers
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

import numpy as np
from scipy.constants import G, c, parsec


MASS1_MSUN = 1.4
MASS2_MSUN = 1.4
SNR = 8.0
HORIZON_TO_RANGE = 2.2648
SOLAR_MASS_KG = 1.988409870698051e30
MAX_SPECTRA_BYTES = 1024**3

IFO_OMC_MISMATCH = ("Optics", "MM_IFO_OMC")
SQZ_OMC_MISMATCH = ("Squeezer", "MM_SQZ_OMC")
IFO_OMC_PHASE = ("Optics", "MM_IFO_OMCphi")
SQZ_OMC_PHASE = ("Squeezer", "MM_SQZ_OMCphi")

COMMON_FIELDS = [
    ("Optics.SRM.Tunephase", "SEC detuning [rad]"),
    ("Squeezer.SQZAngle", "Injected squeezing angle [rad]"),
    ("Squeezer.FilterCavity.fdetune", "FC detuning [Hz]"),
    ("Optics.Quadrature.dc", "Readout quadrature angle [rad]"),
    ("Laser.ArmPower", "Circulating arm power [W]"),
    ("Squeezer.AmplitudedB", "Generated squeezing [dB]"),
    ("Squeezer.FilterCavity.Ti", "FC input transmission [fraction]"),
    ("Squeezer.FilterCavity.Lrt", "FC round-trip loss [fraction]"),
    ("Squeezer.FilterCavity.Te", "FC end transmission [fraction]"),
    ("Squeezer.FilterCavity.L", "FC length [m]"),
    ("Squeezer.FilterCavity.Lrms", "FC length noise [m RMS]"),
    ("Squeezer.InjectionLoss", "Injection loss [fraction]"),
    ("Squeezer.SQZAngleRMS", "Squeezing angle noise [rad RMS]"),
    ("Squeezer.LOAngleRMS", "LO angle noise [rad RMS]"),
    ("Optics.PhotoDetectorEfficiency", "Photodetector efficiency [fraction]"),
    ("Optics.MM_IFO_OMC", "IFO–OMC mismatch [fraction]"),
    ("Optics.MM_IFO_OMCphi", "IFO–OMC mismatch phase [rad]"),
    ("Squeezer.MM_SQZ_OMC", "SQZ–OMC mismatch [fraction]"),
    ("Squeezer.MM_SQZ_OMCphi", "SQZ–OMC mismatch phase [rad]"),
    ("Squeezer.FilterCavity.L_mm", "SQZ–FC mismatch [fraction]"),
    ("Squeezer.FilterCavity.psi_mm", "SQZ–FC mismatch phase [rad]"),
    ("Optics.MM_ARM_SRC", "Arm–SRC mismatch [fraction]"),
    ("Optics.MM_ARM_SRCphi", "Arm–SRC mismatch phase [rad]"),
    ("Optics.SRM.Transmittance", "SRM transmission [fraction]"),
    ("Optics.Loss", "Arm optical loss [fraction]"),
]


PathPart = str | int
PathLike = Sequence[PathPart]


def normalize_path(path: PathLike) -> tuple[PathPart, ...]:
    """Normalize JSON parameter paths, retaining list indices as integers."""
    result: list[PathPart] = []
    for part in path:
        if isinstance(part, bool):
            raise ValueError("A Boolean cannot be a parameter-path element.")
        if isinstance(part, int):
            result.append(part)
        elif isinstance(part, str):
            result.append(part)
        else:
            raise ValueError("A parameter path may contain only strings and integers.")
    if not result:
        raise ValueError("A parameter path cannot be empty.")
    return tuple(result)


def path_text(path: PathLike) -> str:
    text = ""
    for part in path:
        text += f"[{part}]" if isinstance(part, int) else ("." if text else "") + str(part)
    return text


def numeric_fields(value: Any, path: tuple[PathPart, ...] = ()) -> Iterable[tuple[tuple[PathPart, ...], float]]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield from numeric_fields(child, path + (key,))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from numeric_fields(child, path + (index,))
    elif isinstance(value, numbers.Real) and not isinstance(value, bool) and np.isfinite(value):
        yield path, float(value)


@dataclass(frozen=True)
class Parameter:
    path: tuple[PathPart, ...]
    label: str
    default: float

    @property
    def name(self) -> str:
        return path_text(self.path)

    def as_json(self) -> dict[str, Any]:
        return {"path": list(self.path), "name": self.name, "label": self.label, "default": self.default}


def parameters_from_yaml(data: dict[str, Any]) -> list[Parameter]:
    leaves = dict(numeric_fields(data))
    result: list[Parameter] = []
    for name, label in COMMON_FIELDS:
        path = tuple(name.split("."))
        if path in leaves:
            result.append(Parameter(path, label, leaves.pop(path)))
    result.extend(
        Parameter(path, path_text(path), value)
        for path, value in sorted(leaves.items(), key=lambda item: path_text(item[0]))
    )
    return result


def get_model_value(model: Any, path: PathLike) -> Any:
    for part in path:
        model = model[part] if isinstance(part, int) or isinstance(model, dict) else getattr(model, part)
    return model


def set_model_value(model: Any, path: PathLike, value: float) -> None:
    """Change one existing value in a GWINC Struct, dictionary, or list."""
    path = normalize_path(path)
    target = model
    for part in path[:-1]:
        target = target[part] if isinstance(part, int) or isinstance(target, dict) else getattr(target, part)
    last = path[-1]
    if isinstance(last, int):
        target[last] = float(value)
    elif isinstance(target, dict):
        if last not in target:
            raise KeyError(path_text(path))
        target[last] = float(value)
    else:
        if not hasattr(target, last):
            raise AttributeError(f"GWINC model has no field {path_text(path)}")
        setattr(target, last, float(value))


def apply_parameter_overrides(model: Any, overrides: dict[tuple[PathPart, ...], float]) -> Any:
    configured = copy.deepcopy(model)
    for path, value in overrides.items():
        set_model_value(configured, path, value)
    return configured


def quantum_spectra(quantum_psd: np.ndarray, ifo: Any, output_units: str) -> tuple[np.ndarray, np.ndarray]:
    """Return strain PSD for BNS and displacement ASD for plotting."""
    psd = np.asarray(quantum_psd, dtype=float)
    if np.any(~np.isfinite(psd)) or np.any(psd <= 0):
        raise ValueError("Quantum PSD contains nonfinite or nonpositive values.")
    length = float(get_model_value(ifo, ("Infrastructure", "Length")))
    if not np.isfinite(length) or length <= 0:
        raise ValueError("Arm length must be positive for displacement/strain conversion.")
    if output_units == "displacement":
        return psd / length**2, np.sqrt(psd)
    if output_units == "strain":
        return psd.copy(), np.sqrt(psd) * length
    raise ValueError(f"Unknown GWINC calibration: {output_units}")


def isco_frequency(mass1: float = MASS1_MSUN, mass2: float = MASS2_MSUN) -> float:
    masses = np.asarray([mass1, mass2], dtype=float)
    if np.any(~np.isfinite(masses)) or np.any(masses <= 0):
        raise ValueError("Both component masses must be finite and positive, in solar masses.")
    total_mass = float(np.sum(masses)) * SOLAR_MASS_KG
    return float(c**3 / (6**1.5 * np.pi * G * total_mass))


class BNSRange:
    """Exact desktop-app BNS integrator, including the ISCO-clipped grid weights."""

    def __init__(self, fmin: float, fmax: float | None, points: int,
                 mass1: float = MASS1_MSUN, mass2: float = MASS2_MSUN,
                 frequency_grid: np.ndarray | None = None):
        self.mass1, self.mass2 = float(mass1), float(mass2)
        self.isco_hz = isco_frequency(self.mass1, self.mass2)
        cap = self.isco_hz if fmax is None or float(fmax) == 0 else float(fmax)
        self.fmin, self.fmax = float(fmin), min(cap, self.isco_hz)
        if not np.isfinite(cap) or not np.isfinite(self.fmin) or not 0 < self.fmin < self.fmax:
            raise ValueError("Require 0 < lower frequency < upper frequency (capped at ISCO).")
        if int(points) < 2:
            raise ValueError("Use at least two frequency points.")
        self.freq = (np.geomspace(self.fmin, self.fmax, int(points)) if frequency_grid is None
                     else np.asarray(frequency_grid, dtype=float).copy())
        f = self.freq
        if (f.ndim != 1 or len(f) < 2 or np.any(~np.isfinite(f)) or np.any(f <= 0)
                or np.any(np.diff(f) <= 0)):
            raise ValueError("The spectral grid must contain positive, increasing finite frequencies.")
        if f[0] > self.fmin or f[-1] < self.fmax:
            raise ValueError(
                f"These masses require spectra from {self.fmin:.6g} to {self.fmax:.6g} Hz; "
                f"the cache covers {f[0]:.6g} to {f[-1]:.6g} Hz. Run the sweep again with these masses."
            )
        left = np.maximum(f[:-1], self.fmin)
        right = np.minimum(f[1:], self.fmax)
        width = np.maximum(right - left, 0.0)
        right_weight = width * (np.maximum(left - f[:-1], 0) + np.maximum(right - f[:-1], 0)) / (2 * np.diff(f))
        weights = np.zeros_like(f)
        weights[:-1] += width - right_weight
        weights[1:] += right_weight
        self.weights = weights * f**(-7 / 3)
        chirp_mass = (self.mass1 * self.mass2)**(3 / 5) / (self.mass1 + self.mass2)**(1 / 5)
        chirp_mass *= SOLAR_MASS_KG
        self.factor = (
            c / (SNR * HORIZON_TO_RANGE * 1e6 * parsec)
            * np.sqrt((5 / 6) * np.pi**(-4 / 3) * (G * chirp_mass / c**3)**(5 / 3))
        )

    def __call__(self, strain_psd: np.ndarray) -> float:
        psd = np.asarray(strain_psd, dtype=float)
        if psd.shape != self.freq.shape:
            raise ValueError(f"Quantum PSD has shape {psd.shape}; expected {self.freq.shape}.")
        if np.any(~np.isfinite(psd)) or np.any(psd <= 0):
            raise ValueError("Quantum strain PSD contains nonfinite or nonpositive values.")
        return float(self.factor * np.sqrt(np.sum(self.weights / psd)))

    def metadata(self) -> dict[str, Any]:
        return {
            "mass1_msun": self.mass1, "mass2_msun": self.mass2,
            "snr": SNR, "horizon_to_range": HORIZON_TO_RANGE,
            "fmin_hz": self.fmin, "fmax_hz": self.fmax, "isco_hz": self.isco_hz,
            "waveform": "Leading inspiral amplitude; Schwarzschild ISCO cutoff; no merger, ringdown or tidal model",
            "distance": "Euclidean, orientation-averaged, quantum-noise-only range [Mpc]",
        }


def shared_range_metrics(fmin: float, fmax: float | None, points: int,
                         mass1: float, mass2: float) -> tuple[BNSRange, BNSRange]:
    """Use one frequency grid that covers both the standard and alternate BNS band."""
    standard = BNSRange(fmin, fmax, points)
    alternative = BNSRange(fmin, fmax, points, mass1, mass2)
    grid = np.unique(np.r_[
        np.geomspace(float(fmin), max(standard.fmax, alternative.fmax), int(points)),
        standard.fmax, alternative.fmax,
    ])
    return (
        BNSRange(fmin, fmax, points, frequency_grid=grid),
        BNSRange(fmin, fmax, points, mass1, mass2, frequency_grid=grid),
    )


def sweep_arm_lengths(model: Any, x_path: PathLike, y_path: PathLike,
                      xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    length_path = ("Infrastructure", "Length")
    lengths = np.full((len(ys), len(xs)), float(get_model_value(model, length_path)))
    if tuple(x_path) == length_path:
        lengths[:] = np.asarray(xs)[None, :]
    elif tuple(y_path) == length_path:
        lengths[:] = np.asarray(ys)[:, None]
    return lengths


def is_sqz_ifo_mismatch_sweep(x_path: PathLike, y_path: PathLike) -> bool:
    pair = {tuple(x_path), tuple(y_path)}
    return len(pair) == 2 and pair <= {IFO_OMC_MISMATCH, SQZ_OMC_MISMATCH, IFO_OMC_PHASE, SQZ_OMC_PHASE}


def coherent_sqz_ifo_mismatch(ifo_omc: Any, sqz_omc: Any,
                               ifo_phase: Any, sqz_phase: Any) -> np.ndarray:
    """Coherent fundamental-plus-one-HOM overlap in the common OMC basis."""
    ei, es, pi, ps = np.broadcast_arrays(*[
        np.asarray(value, dtype=float) for value in (ifo_omc, sqz_omc, ifo_phase, sqz_phase)
    ])
    valid = (np.isfinite(ei) & np.isfinite(es) & np.isfinite(pi) & np.isfinite(ps)
             & (ei >= 0) & (ei <= 1) & (es >= 0) & (es <= 1))
    safe_i, safe_s = np.where(valid, ei, 0.0), np.where(valid, es, 0.0)
    with np.errstate(invalid="ignore", over="ignore"):
        delta = np.where(valid, ps, 0.0) - np.where(valid, pi, 0.0)
        amplitude = (np.sqrt(safe_s * (1 - safe_i)) * np.exp(1j * delta)
                     - np.sqrt(safe_i * (1 - safe_s)))
        result = np.abs(amplitude)**2
    return np.where(valid & np.isfinite(result), np.clip(result, 0.0, 1.0), np.nan)


def sqz_ifo_mismatch_grid(model: Any, x_path: PathLike, y_path: PathLike,
                          xs: np.ndarray, ys: np.ndarray) -> np.ndarray | None:
    if not is_sqz_ifo_mismatch_sweep(x_path, y_path):
        return None
    x_path, y_path = tuple(x_path), tuple(y_path)
    xgrid, ygrid = np.meshgrid(np.asarray(xs, dtype=float), np.asarray(ys, dtype=float))
    inputs: list[Any] = []
    for path in (IFO_OMC_MISMATCH, SQZ_OMC_MISMATCH, IFO_OMC_PHASE, SQZ_OMC_PHASE):
        if path == x_path:
            value = xgrid
        elif path == y_path:
            value = ygrid
        else:
            value = float(get_model_value(model, path))
            if path in (IFO_OMC_PHASE, SQZ_OMC_PHASE) and not np.isfinite(value):
                raise ValueError(f"Fixed mismatch phase {path_text(path)} must be finite.")
        inputs.append(value)
    return 100 * coherent_sqz_ifo_mismatch(*inputs)


def linecut_maximum(range_mpc: np.ndarray, horizontal: bool, ix: int, iy: int) -> tuple[int, int] | None:
    grid = np.asarray(range_mpc, dtype=float)
    line = grid[int(iy), :] if horizontal else grid[:, int(ix)]
    finite = np.flatnonzero(np.isfinite(line))
    if not finite.size:
        return None
    winner = int(finite[np.argmax(line[finite])])
    return (winner, int(iy)) if horizontal else (int(ix), winner)


def all_linecut_maxima(range_mpc: np.ndarray, horizontal: bool) -> np.ndarray:
    grid = np.asarray(range_mpc, dtype=float)
    if grid.ndim != 2:
        raise ValueError("The range map must be two-dimensional.")
    count = grid.shape[0 if horizontal else 1]
    winners = [linecut_maximum(grid, horizontal, index, index) for index in range(count)]
    return np.asarray([point for point in winners if point is not None], dtype=int).reshape(-1, 2)
