#!/usr/bin/env python3
"""Dependency-light checks for the web UI's shared physics and sweep path."""
from __future__ import annotations

import math
import sys
import tempfile
import types
import unittest
from pathlib import Path

import numpy as np
import yaml

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

from backend.core import (  # noqa: E402
    BNSRange, all_linecut_maxima, coherent_sqz_ifo_mismatch, parameters_from_yaml,
    set_model_value,
)
from backend.engine import compute_sweep, reweight_cached_spectra  # noqa: E402


YAML_MODEL = """
Infrastructure:
  Length: 4000.0
Optics:
  MM_IFO_OMC: 0.1
  MM_IFO_OMCphi: 0.0
Squeezer:
  MM_SQZ_OMC: 0.1
  MM_SQZ_OMCphi: 0.0
  FilterCavity:
    Ti: 0.014
"""


class FakeBudget:
    """Minimal GWINC-shaped budget used to exercise the real sweep engine."""

    def __init__(self, freq, ifo):
        self.freq = np.asarray(freq, dtype=float)
        self.ifo = ifo

    def run(self):
        # Changing Ti and IFO–OMC mismatch gives nontrivial maps but stays positive.
        ti = float(self.ifo["Squeezer"]["FilterCavity"]["Ti"])
        mismatch = float(self.ifo["Optics"]["MM_IFO_OMC"])
        scale = 1 + 20 * ti + mismatch
        return types.SimpleNamespace(psd=scale * 1e-40 * (1 + (self.freq / 250.0) ** 2))


def fake_load_budget(path, freq, bname):
    assert bname == "Quantum"
    return FakeBudget(freq, yaml.safe_load(Path(path).read_text()))


class CoreAndEngineTests(unittest.TestCase):
    def test_mismatch_formula_has_expected_limits(self):
        self.assertAlmostEqual(float(coherent_sqz_ifo_mismatch(0, 0, 0, 0)), 0.0)
        self.assertAlmostEqual(float(coherent_sqz_ifo_mismatch(0, 0.2, 0, 0)), 0.2)
        self.assertAlmostEqual(float(coherent_sqz_ifo_mismatch(0.1, 0.1, 0, 0)), 0.0)
        self.assertAlmostEqual(float(coherent_sqz_ifo_mismatch(0.1, 0.1, 0, math.pi)), 0.36)

    def test_bns_range_and_line_winners(self):
        metric = BNSRange(10, None, 301)
        range_mpc = metric(np.full_like(metric.freq, 1e-46))
        self.assertTrue(math.isfinite(range_mpc) and range_mpc > 0)
        grid = np.array([[1.0, 3.0, np.nan], [4.0, 2.0, 5.0]])
        self.assertTrue(np.array_equal(all_linecut_maxima(grid, True), np.array([[1, 0], [2, 1]])))
        self.assertTrue(np.array_equal(all_linecut_maxima(grid, False), np.array([[0, 1], [1, 0], [2, 1]])))

    def test_parameter_paths_preserve_yaml_values(self):
        data = yaml.safe_load(YAML_MODEL)
        fields = parameters_from_yaml(data)
        ti = next(field for field in fields if field.name == "Squeezer.FilterCavity.Ti")
        self.assertEqual(ti.default, 0.014)
        set_model_value(data, ti.path, 0.02)
        self.assertEqual(data["Squeezer"]["FilterCavity"]["Ti"], 0.02)

    def test_engine_and_cached_mass_reweighting(self):
        fake_gwinc = types.SimpleNamespace(__version__="test", load_budget=fake_load_budget)
        previous = sys.modules.get("gwinc")
        sys.modules["gwinc"] = fake_gwinc
        try:
            request = {
                "yaml_text": YAML_MODEL,
                "x_axis": {"path": ["Squeezer", "FilterCavity", "Ti"], "minimum": 0.01, "maximum": 0.02, "points": 3},
                "y_axis": {"path": ["Optics", "MM_IFO_OMC"], "minimum": 0.05, "maximum": 0.15, "points": 2},
                "fixed_overrides": [], "fmin_hz": 10.0, "fmax_hz": 300.0, "frequency_points": 101,
                "alternative_mass1_msun": 1.4, "alternative_mass2_msun": 1.4,
                "output_calibration": "displacement",
            }
            updates = []
            result = compute_sweep(request, lambda: False, lambda done, total, message: updates.append((done, total)))
        finally:
            if previous is None:
                sys.modules.pop("gwinc", None)
            else:
                sys.modules["gwinc"] = previous
        self.assertFalse(result["cancelled"])
        self.assertEqual(result["range_mpc"].shape, (2, 3))
        self.assertTrue(np.all(np.isfinite(result["range_mpc"])))
        self.assertEqual(result["displacement_asd"].shape, (2, 3, 101))
        self.assertEqual(updates[-1], (6, 6))
        reweighted = reweight_cached_spectra(result, 1.4, 1.4)
        self.assertTrue(np.allclose(reweighted, result["range_mpc"], rtol=1e-12, atol=0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
