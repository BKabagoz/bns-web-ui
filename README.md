# Quantum-noise BNS sweeps — browser version

This is a browser front end plus a local Python calculation service for the
quantum-noise-only BNS sweep UI. It preserves the desktop app's BNS convention:
the standard 1.4 + 1.4 solar-mass, orientation-averaged leading-inspiral range
at SNR 8, calculated from quantum noise alone. It does not add classical noise,
merger, ringdown, tidal, or cosmological corrections.

The files are arranged so the browser interface can live on GitHub Pages while
the GWINC calculations run on a laptop or a future Mac mini:

```text
frontend/             Static browser UI for GitHub Pages
backend/              FastAPI service and one- or two-worker calculation queue
.github/workflows/    GitHub Pages deployment workflow
```

## First local run

Use the same Python installation in which the desktop UI can run GWINC. From
this directory:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Then open <http://127.0.0.1:8000>. The server serves the browser UI locally,
so no GitHub account, domain, or tunnel is needed for this first test.

The UI includes a built-in BNS example at `frontend/examples/default.yaml`.
It loads automatically after the compute server connects, and the **Load
built-in example** button restores it after a visitor chooses another file.
This YAML is deliberately public: do not put secrets, private paths, or
unpublished configuration values in it. Visitors can instead choose a YAML
model from their computer. The browser uploads its text to the server for this
calculation only; it does not give visitors a way to browse the server's files.
The parameter editor starts from the YAML values. Blank fixed fields retain the
YAML values, and the selected X/Y fields always use their sweep grids.

When one of the filter-cavity linewidth inputs (`L`, `Ti`, `Te`, or `Lrt`) is
selected as a sweep axis, the controls show the half-width at half-maximum
(HWHM) and full width at half-maximum (FWHM). With a linewidth input on an
axis, the displayed interval is the range across its requested sweep bounds.

The calculation service keeps the spectra in RAM after a completed sweep. This
makes map clicks, selected-line plots, best-of-every-line plots, winning X/Y
points, cached mass reweighting through the API, and full-result NPZ download
available without new GWINC calls. After a sweep, the browser also provides
CSV downloads for the map and currently displayed ASD data, plus PNG downloads
for both figures. The same 1 GiB spectrum-cache limit used by the desktop UI
is enforced per job.

## Queue and cancellation

The service starts with one worker, so a second visitor waits rather than
competing with the first calculation. Set this before starting the server to
allow two simultaneous calculation workers:

```bash
export BNS_WORKER_CONCURRENCY=2
uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Cancellation takes effect between GWINC grid-point calls. A current call is
allowed to finish so it does not corrupt the worker process.

## Publish the static interface to GitHub Pages

1. Create an empty GitHub repository and add these files.
2. In repository **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Push the `main` branch. The included workflow publishes `frontend/` at
   `https://YOUR-GITHUB-NAME.github.io/REPOSITORY-NAME/`.
4. Open that page, paste the compute-server address in the header, and choose
   the same YAML workflow as in the local version.

The GitHub page contains no GWINC installation, YAML library, or calculation
cache. It only sends requests to the compute server that you choose.

## Expose the laptop temporarily

With the service running locally, a Cloudflare quick tunnel can create an HTTPS
address for a test session:

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

Paste the printed `https://…trycloudflare.com` address into the browser UI's
**Compute-server address** field. The address stops working when the tunnel or
laptop stops. A long-lived tunnel and a custom `api.yourdomain.org` address can
replace this later without changing the static GitHub Pages site.

## Access control

For local development, no token is required. For a small trusted group, start
the server with a shared token:

```bash
export BNS_ACCESS_TOKEN='choose-a-long-random-value'
uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Each trusted person enters that token in the header field after opening the
GitHub Page. It is never embedded in the published HTML or JavaScript. Before
opening the server broadly to the public, add real account-based authentication
and rate limits; a shared token is suitable only for early trusted testing.

## Checks without GWINC

The dependency-light checks exercise the exact BNS integrator, mismatch
formula, YAML parameter paths, a synthetic GWINC-shaped sweep, and cached mass
reweighting:

```bash
python tests/test_core_and_engine.py
```
