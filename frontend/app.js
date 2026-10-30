/* Browser client for the local quantum-noise BNS calculation service.
 * The client is deliberately static: it can be deployed unchanged to GitHub
 * Pages, while all GWINC work and retained spectra live on the compute server.
 */

const state = {
  apiBase: "",
  token: "",
  yamlText: "",
  yamlName: "",
  parameters: [],
  overrides: new Map(),
  job: null,
  result: null,
  mapKind: "standard",
  analysisKind: "line",
  selection: { ix: 0, iy: 0 },
  pollTimer: null,
  colorscales: { map: "Viridis", asd: "Viridis" },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const elements = {
  app: $("#application"), controls: $("#controls"), apiBase: $("#api-base"), token: $("#access-token"),
  serverStatus: $("#server-status"), checkServer: $("#check-server"), yamlFile: $("#yaml-file"),
  yamlStatus: $("#yaml-status"), xParameter: $("#x-parameter"), yParameter: $("#y-parameter"),
  xMinimum: $("#x-minimum"), xMaximum: $("#x-maximum"), xPoints: $("#x-points"),
  yMinimum: $("#y-minimum"), yMaximum: $("#y-maximum"), yPoints: $("#y-points"),
  gridReadout: $("#grid-readout"), parameterEditor: $("#parameter-editor"),
  parameterFilter: $("#parameter-filter"), overrideCount: $("#override-count"),
  fmin: $("#fmin"), fmax: $("#fmax"), frequencyPoints: $("#frequency-points"),
  outputCalibration: $("#output-calibration"), altMass1: $("#alternative-mass-1"), altMass2: $("#alternative-mass-2"),
  colorscaleTarget: $("#colorscale-target"), mapColorscale: $("#map-colorscale"), lineOrientation: $("#line-orientation"),
  showWinners: $("#show-winners"), showLegend: $("#show-legend"), run: $("#run-sweep"), cancel: $("#cancel-sweep"),
  download: $("#download-results"), jobTitle: $("#job-title"), jobMessage: $("#job-message"),
  jobProgress: $("#job-progress"), jobProgressText: $("#job-progress-text"), jobId: $("#job-id"),
  mapPlot: $("#map-plot"), mapTitle: $("#map-title"), mapReadout: $("#map-readout"),
  analysisPlot: $("#analysis-plot"), analysisTitle: $("#analysis-title"), analysisReadout: $("#analysis-readout"),
  mismatchTab: $("#mismatch-tab"), resultNotes: $("#result-notes"),
  conventionNote: $("#convention-note"), timingNote: $("#timing-note"), errorsNote: $("#errors-note"),
};

function initialApiBase() {
  const remembered = localStorage.getItem("bns-api-base");
  if (remembered) return remembered;
  return window.location.hostname.endsWith("github.io") ? "" : window.location.origin;
}

function normalizeBase(value) {
  return value.trim().replace(/\/+$/, "");
}

function setServerStatus(text, style = "") {
  elements.serverStatus.textContent = text;
  elements.serverStatus.className = `server-status ${style}`;
}

function setJobPanel(title, message, completed = 0, total = 0) {
  elements.jobTitle.textContent = title;
  elements.jobMessage.textContent = message;
  elements.jobProgress.max = Math.max(total || 1, 1);
  elements.jobProgress.value = Math.min(completed, elements.jobProgress.max);
  elements.jobProgressText.textContent = total ? `${completed.toLocaleString()} / ${total.toLocaleString()}` : "—";
}

function apiHeaders(headers = {}) {
  const result = { ...headers };
  if (state.token) result["X-BNS-Access-Token"] = state.token;
  return result;
}

async function api(path, options = {}) {
  const base = normalizeBase(state.apiBase || elements.apiBase.value);
  if (!base) throw new Error("Enter the address of the compute server first.");
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: apiHeaders(options.headers || {}),
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : detail;
    } catch (_) { /* A plain HTTP error is still useful. */ }
    throw new Error(detail);
  }
  return response;
}

async function apiJson(path, options = {}) {
  const response = await api(path, options);
  return response.json();
}

function numberValue(element, label, { integer = false, optional = false } = {}) {
  const raw = element.value.trim();
  if (optional && !raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  if (integer && !Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
  return value;
}

function pathFor(select) {
  if (!select.value) throw new Error("Choose both sweep parameters.");
  return JSON.parse(select.value);
}

function samePath(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parameterFor(select) {
  const path = pathFor(select);
  return state.parameters.find((parameter) => samePath(parameter.path, path));
}

function formatNumber(value, digits = 5) {
  return Number.isFinite(value) ? Number(value).toPrecision(digits) : "—";
}

function escapeText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

async function checkServer() {
  state.apiBase = normalizeBase(elements.apiBase.value);
  if (!state.apiBase) {
    setServerStatus("Enter a public tunnel address, or open this page through the local server.", "problem");
    return;
  }
  localStorage.setItem("bns-api-base", state.apiBase);
  state.token = elements.token.value.trim();
  setServerStatus("Checking compute server…");
  try {
    const health = await apiJson("/api/health");
    const suffix = health.gwinc_version ? ` GWINC ${health.gwinc_version} is available.` : " GWINC is not installed yet.";
    setServerStatus(`Connected. ${health.worker_concurrency} calculation worker${health.worker_concurrency === 1 ? "" : "s"}.${suffix}`, health.gwinc_version ? "ok" : "problem");
  } catch (error) {
    setServerStatus(`Could not reach the compute server: ${error.message}`, "problem");
  }
}

function setInputsEnabled(enabled) {
  [elements.xParameter, elements.yParameter, elements.xMinimum, elements.xMaximum, elements.xPoints,
   elements.yMinimum, elements.yMaximum, elements.yPoints].forEach((element) => { element.disabled = !enabled; });
  elements.run.disabled = !enabled;
}

function makeOption(parameter) {
  const option = document.createElement("option");
  option.value = JSON.stringify(parameter.path);
  option.textContent = `${parameter.label} — ${parameter.name}`;
  return option;
}

function populateParameters(parameters) {
  state.parameters = parameters;
  for (const select of [elements.xParameter, elements.yParameter]) {
    select.replaceChildren();
    parameters.forEach((parameter) => select.append(makeOption(parameter)));
  }
  elements.xParameter.selectedIndex = 0;
  elements.yParameter.selectedIndex = Math.min(1, Math.max(0, parameters.length - 1));
  setInputsEnabled(parameters.length >= 2);
  setAxisDefaults("x");
  setAxisDefaults("y");
  renderParameterEditor();
  updateGridReadout();
}

function setAxisDefaults(axis) {
  const select = axis === "x" ? elements.xParameter : elements.yParameter;
  if (!select.value) return;
  const parameter = parameterFor(select);
  const minimum = axis === "x" ? elements.xMinimum : elements.yMinimum;
  const maximum = axis === "x" ? elements.xMaximum : elements.yMaximum;
  const value = Number(parameter.default);
  minimum.value = String(0.5 * value);
  maximum.value = String(1.5 * value);
}

function currentSweepPaths() {
  if (!state.parameters.length) return [];
  try { return [pathFor(elements.xParameter), pathFor(elements.yParameter)]; }
  catch (_) { return []; }
}

function renderParameterEditor() {
  const filter = elements.parameterFilter.value.trim().toLowerCase();
  const swept = currentSweepPaths();
  const fragment = document.createDocumentFragment();
  let shown = 0;
  state.parameters.forEach((parameter) => {
    const searchText = `${parameter.label} ${parameter.name}`.toLowerCase();
    if (filter && !searchText.includes(filter)) return;
    shown += 1;
    const row = document.createElement("label");
    const disabled = swept.some((path) => samePath(path, parameter.path));
    row.className = `parameter-row ${disabled ? "disabled" : ""}`;
    const name = document.createElement("span");
    name.className = "parameter-name";
    name.title = `${parameter.label}\n${parameter.name}\nYAML default: ${parameter.default}`;
    name.innerHTML = `<strong>${escapeText(parameter.label)}</strong><br>${escapeText(parameter.name)}`;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = String(parameter.default);
    input.value = state.overrides.get(JSON.stringify(parameter.path)) || "";
    input.disabled = disabled;
    input.dataset.path = JSON.stringify(parameter.path);
    input.addEventListener("input", () => {
      const key = input.dataset.path;
      if (input.value.trim()) state.overrides.set(key, input.value.trim());
      else state.overrides.delete(key);
      updateOverrideCount();
    });
    row.append(name, input);
    fragment.append(row);
  });
  elements.parameterEditor.replaceChildren(fragment);
  if (!shown) elements.parameterEditor.textContent = "No matching numeric YAML fields.";
  updateOverrideCount();
}

function updateOverrideCount() {
  let count = 0;
  const swept = currentSweepPaths();
  state.overrides.forEach((value, key) => {
    try {
      if (!swept.some((path) => samePath(path, JSON.parse(key)))) count += 1;
    } catch (_) { /* Ignore stale values from a prior model. */ }
  });
  elements.overrideCount.textContent = count ? `(${count})` : "";
}

function updateGridReadout() {
  if (!state.parameters.length) return;
  try {
    const nx = numberValue(elements.xPoints, "X samples", { integer: true });
    const ny = numberValue(elements.yPoints, "Y samples", { integer: true });
    elements.gridReadout.textContent = `${nx} × ${ny} = ${(nx * ny).toLocaleString()} GWINC grid points, plus one unchanged-YAML baseline.`;
  } catch (error) {
    elements.gridReadout.textContent = error.message;
  }
}

async function loadYamlFile(file) {
  if (!file) return;
  state.yamlText = await file.text();
  state.yamlName = file.name;
  elements.yamlStatus.textContent = `Reading ${file.name}…`;
  try {
    const response = await apiJson("/api/model/parameters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml_text: state.yamlText }),
    });
    state.overrides.clear();
    populateParameters(response.parameters);
    elements.yamlStatus.textContent = `${file.name}: ${response.parameters.length} finite numeric fields are available.`;
    setJobPanel("Model loaded", "Choose axes and submit a calculation when ready.");
  } catch (error) {
    state.yamlText = "";
    state.parameters = [];
    setInputsEnabled(false);
    elements.yamlStatus.textContent = `Could not load this YAML: ${error.message}`;
    setJobPanel("Model not loaded", error.message);
  }
}

function collectOverrides() {
  const swept = currentSweepPaths();
  const overrides = [];
  state.overrides.forEach((raw, key) => {
    const path = JSON.parse(key);
    if (swept.some((item) => samePath(item, path))) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Fixed value for ${path.join(".")} must be finite.`);
    overrides.push({ path, value });
  });
  return overrides;
}

function buildRequest() {
  const xPath = pathFor(elements.xParameter);
  const yPath = pathFor(elements.yParameter);
  if (samePath(xPath, yPath)) throw new Error("Choose two different sweep parameters.");
  const request = {
    yaml_text: state.yamlText,
    x_axis: {
      path: xPath,
      minimum: numberValue(elements.xMinimum, "X minimum"),
      maximum: numberValue(elements.xMaximum, "X maximum"),
      points: numberValue(elements.xPoints, "X samples", { integer: true }),
    },
    y_axis: {
      path: yPath,
      minimum: numberValue(elements.yMinimum, "Y minimum"),
      maximum: numberValue(elements.yMaximum, "Y maximum"),
      points: numberValue(elements.yPoints, "Y samples", { integer: true }),
    },
    fixed_overrides: collectOverrides(),
    fmin_hz: numberValue(elements.fmin, "Lower frequency"),
    fmax_hz: numberValue(elements.fmax, "Upper frequency", { optional: true }),
    frequency_points: numberValue(elements.frequencyPoints, "Frequency samples", { integer: true }),
    alternative_mass1_msun: numberValue(elements.altMass1, "Alternative mass 1"),
    alternative_mass2_msun: numberValue(elements.altMass2, "Alternative mass 2"),
    output_calibration: elements.outputCalibration.value,
  };
  if (request.x_axis.minimum === request.x_axis.maximum || request.y_axis.minimum === request.y_axis.maximum) {
    throw new Error("Each sweep axis needs two different bounds.");
  }
  return request;
}

async function runSweep() {
  if (!state.yamlText) {
    setJobPanel("Model required", "Choose and load a YAML model first.");
    return;
  }
  try {
    state.apiBase = normalizeBase(elements.apiBase.value);
    state.token = elements.token.value.trim();
    const request = buildRequest();
    elements.run.disabled = true;
    setJobPanel("Submitting", "Adding the calculation to the compute-server queue…");
    const job = await apiJson("/api/jobs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    });
    state.job = job;
    state.result = null;
    elements.cancel.disabled = false;
    elements.download.disabled = true;
    elements.jobId.textContent = `job ${job.id.slice(0, 8)}`;
    updateJob(job);
    startPolling();
  } catch (error) {
    elements.run.disabled = false;
    setJobPanel("Could not start sweep", error.message);
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(pollJob, 900);
  pollJob();
}

function stopPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function pollJob() {
  if (!state.job) return;
  try {
    const job = await apiJson(`/api/jobs/${state.job.id}`);
    state.job = job;
    updateJob(job);
    if (job.status === "completed") {
      stopPolling();
      elements.cancel.disabled = true;
      await loadResult();
    } else if (["failed", "cancelled"].includes(job.status)) {
      stopPolling();
      elements.cancel.disabled = true;
      elements.run.disabled = false;
    }
  } catch (error) {
    stopPolling();
    elements.cancel.disabled = true;
    elements.run.disabled = false;
    setJobPanel("Connection lost", error.message);
  }
}

function updateJob(job) {
  const isQueued = job.status === "queued";
  const title = job.status[0].toUpperCase() + job.status.slice(1);
  const position = isQueued && job.queue_position ? ` Queue position ${job.queue_position}.` : "";
  setJobPanel(title, `${job.message || ""}${position}`, job.completed_points || 0, job.total_points || 0);
  if (job.status === "failed" && job.error) elements.jobMessage.textContent = job.error;
}

async function cancelSweep() {
  if (!state.job) return;
  try {
    const job = await apiJson(`/api/jobs/${state.job.id}`, { method: "DELETE" });
    state.job = job;
    updateJob(job);
  } catch (error) {
    setJobPanel("Could not cancel", error.message);
  }
}

function closestIndex(values, target) {
  let best = 0;
  let distance = Infinity;
  values.forEach((value, index) => {
    const current = Math.abs(value - target);
    if (current < distance) { best = index; distance = current; }
  });
  return best;
}

async function loadResult() {
  try {
    state.result = await apiJson(`/api/jobs/${state.job.id}/result`);
    state.selection = {
      ix: closestIndex(state.result.x, state.result.x_parameter.default),
      iy: closestIndex(state.result.y, state.result.y_parameter.default),
    };
    elements.run.disabled = false;
    elements.download.disabled = false;
    renderResult();
    setJobPanel("Complete", `Calculated ${state.result.completed_points.toLocaleString()} grid points in ${state.result.elapsed_s.toFixed(1)} s.`, state.result.completed_points, state.result.total_points);
  } catch (error) {
    elements.run.disabled = false;
    setJobPanel("Could not load result", error.message);
  }
}

function mapInfo(kind) {
  if (kind === "alternative") {
    const metadata = state.result.metadata.alternative_range;
    return { grid: state.result.alternative_range_mpc, title: `Alternative BNS range: ${metadata.mass1_msun} + ${metadata.mass2_msun} M⊙`, colorTitle: "Range [Mpc]", rangeKind: "alternative" };
  }
  if (kind === "mismatch") {
    return { grid: state.result.sqz_ifo_mismatch_percent, title: "Derived SQZ–IFO mode mismatch", colorTitle: "Mismatch [%]", rangeKind: "standard" };
  }
  return { grid: state.result.range_mpc, title: "BNS range: 1.4 + 1.4 M⊙", colorTitle: "Range [Mpc]", rangeKind: "standard" };
}

function winners(grid, horizontal) {
  const result = [];
  if (!grid) return result;
  if (horizontal) {
    grid.forEach((row, iy) => {
      let best = -Infinity; let ix = -1;
      row.forEach((value, candidate) => { if (Number.isFinite(value) && value > best) { best = value; ix = candidate; } });
      if (ix >= 0) result.push({ ix, iy, value: best });
    });
  } else {
    const columns = grid[0]?.length || 0;
    for (let ix = 0; ix < columns; ix += 1) {
      let best = -Infinity; let iy = -1;
      grid.forEach((row, candidate) => { const value = row[ix]; if (Number.isFinite(value) && value > best) { best = value; iy = candidate; } });
      if (iy >= 0) result.push({ ix, iy, value: best });
    }
  }
  return result;
}

function plotTheme() {
  return {
    paper_bgcolor: "#111a22", plot_bgcolor: "#111a22", font: { color: "#dce6ea", size: 11 },
    margin: { l: 68, r: 26, t: 32, b: 58 }, hoverlabel: { bgcolor: "#081016", font: { color: "#edf3f5" } },
  };
}

function insideSweep(value, samples) {
  const lower = Math.min(...samples);
  const upper = Math.max(...samples);
  return Number.isFinite(value) && lower <= value && value <= upper;
}

function inPlotLegend() {
  return {
    x: 0.985, y: 0.985, xanchor: "right", yanchor: "top",
    font: { size: 9, color: "#edf3f5" }, bgcolor: "rgba(8,16,22,.82)",
    bordercolor: "rgba(163,183,194,.52)", borderwidth: 1,
    traceorder: "normal", itemsizing: "constant",
  };
}

// Small sampled versions of the named Plotly palettes.  Heatmaps use Plotly's
// native palette name; line traces need one explicit color per curve.
const COLOR_STOPS = {
  Viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  Plasma: ["#0d0887", "#7e03a8", "#cc4778", "#f89540", "#f0f921"],
  Inferno: ["#000004", "#420a68", "#932667", "#dd513a", "#fca50a", "#fcffa4"],
  Magma: ["#000004", "#3b0f70", "#8c2981", "#de4968", "#fe9f6d", "#fcfdbf"],
  Cividis: ["#00224e", "#35456c", "#666970", "#948e76", "#cdbb61", "#fee838"],
  Turbo: ["#30123b", "#4661d6", "#35a7e1", "#1bcfd4", "#4de94c", "#f9e721", "#f48c22", "#b51f29"],
  RdBu: ["#67001f", "#b2182b", "#d6604d", "#f4a582", "#f7f7f7", "#92c5de", "#4393c3", "#2166ac", "#053061"],
};

function hexChannels(hex) {
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function colorAt(colorscale, fraction) {
  const stops = COLOR_STOPS[colorscale] || COLOR_STOPS.Viridis;
  const scaled = Math.max(0, Math.min(1, fraction)) * (stops.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(lower + 1, stops.length - 1);
  const amount = scaled - lower;
  const start = hexChannels(stops[lower]);
  const end = hexChannels(stops[upper]);
  const channels = start.map((value, index) => Math.round(value + (end[index] - value) * amount));
  return `rgba(${channels.join(", ")}, .82)`;
}

function colorscaleFor(target) {
  return state.colorscales[target] || "Viridis";
}

function syncColorscaleControl() {
  elements.mapColorscale.value = colorscaleFor(elements.colorscaleTarget.value);
}

function renderMap() {
  if (!state.result || !window.Plotly) return;
  if (state.mapKind === "mismatch" && !state.result.sqz_ifo_mismatch_percent) state.mapKind = "standard";
  const info = mapInfo(state.mapKind);
  const x = state.result.x;
  const y = state.result.y;
  const horizontal = elements.lineOrientation.value === "horizontal";
  const defaultX = Number(state.result.x_parameter.default);
  const defaultY = Number(state.result.y_parameter.default);
  const defaultInside = insideSweep(defaultX, x) && insideSweep(defaultY, y);
  const traces = [{
    type: "heatmap", x, y, z: info.grid, colorscale: colorscaleFor("map"),
    colorbar: { title: { text: info.colorTitle, side: "right" }, thickness: 13 },
    hovertemplate: `${escapeText(state.result.x_parameter.label)}: %{x:.6g}<br>${escapeText(state.result.y_parameter.label)}: %{y:.6g}<br>${info.colorTitle}: %{z:.6g}<extra></extra>`,
  }];
  if (elements.showWinners.checked && state.mapKind !== "mismatch") {
    const points = winners(info.grid, horizontal);
    traces.push({
      type: "scatter", mode: "markers", x: points.map((point) => x[point.ix]), y: points.map((point) => y[point.iy]),
      marker: { size: 9, color: "rgba(255,255,255,0)", line: { color: "#f3f6f7", width: 1.35 } },
      hovertemplate: "Line winner<br>x=%{x:.6g}<br>y=%{y:.6g}<extra></extra>", name: "Line winners",
    });
  }
  // The selected row/column is the data shown in the Selected line panel.
  traces.push({
    type: "scatter", mode: "lines",
    x: horizontal ? [x[0], x[x.length - 1]] : [x[state.selection.ix], x[state.selection.ix]],
    y: horizontal ? [y[state.selection.iy], y[state.selection.iy]] : [y[0], y[y.length - 1]],
    line: { color: "#f2c768", width: 1.8, dash: "dash" },
    hoverinfo: "skip", showlegend: false, name: "Selected linecut",
  });
  // This is the unedited YAML operating point, not a sweep winner.
  if (defaultInside) {
    traces.push({
      type: "scatter", mode: "markers", x: [defaultX], y: [defaultY],
      marker: { symbol: "square-open", size: 15, color: "#f3f6f7", line: { color: "#f3f6f7", width: 2 } },
      hovertemplate: "Unchanged YAML operating point<br>x=%{x:.6g}<br>y=%{y:.6g}<extra></extra>",
      showlegend: false, name: "YAML operating point",
    });
  }
  const layout = {
    ...plotTheme(), title: { text: info.title, font: { size: 13 } },
    xaxis: { title: state.result.x_parameter.label, gridcolor: "#26343f", zerolinecolor: "#344651" },
    yaxis: { title: state.result.y_parameter.label, gridcolor: "#26343f", zerolinecolor: "#344651" },
    showlegend: false,
  };
  Plotly.react(elements.mapPlot, traces, layout, { responsive: true, displaylogo: false });
  if (elements.mapPlot.removeAllListeners) elements.mapPlot.removeAllListeners("plotly_click");
  elements.mapPlot.on("plotly_click", (event) => {
    const point = event.points?.find((candidate) => candidate.data.type === "heatmap");
    if (!point || state.mapKind === "mismatch") return;
    const [iy, ix] = point.pointNumber;
    state.selection = { ix, iy };
    renderMap();
    renderAnalysis();
  });
  elements.mapTitle.textContent = info.title;
  const operatingPointNote = defaultInside
    ? "The hollow rectangle marks the unchanged YAML operating point."
    : `The YAML operating point (x=${formatNumber(defaultX)}, y=${formatNumber(defaultY)}) is outside this sweep.`;
  if (state.mapKind === "mismatch") {
    elements.mapReadout.textContent = `Derived coherent two-mode SQZ–IFO mismatch in the common OMC basis. It uses no additional GWINC calls. ${operatingPointNote}`;
  } else {
    const selected = info.grid[state.selection.iy]?.[state.selection.ix];
    elements.mapReadout.textContent = `Selected: x=${formatNumber(x[state.selection.ix])}, y=${formatNumber(y[state.selection.iy])}, range=${formatNumber(selected)} Mpc. Click a cell to change the selected line. ${operatingPointNote}`;
  }
}

function lineColor(index, total) {
  // Avoid the very darkest endpoints so every ASD trace remains readable on
  // the dark plot background, including Cividis and Inferno.
  const fraction = .14 + .74 * index / Math.max(total - 1, 1);
  return colorAt(colorscaleFor("asd"), fraction);
}

async function renderSelectedLine() {
  const orientation = elements.lineOrientation.value;
  const rangeKind = state.mapKind === "alternative" ? "alternative" : "standard";
  const index = orientation === "horizontal" ? state.selection.iy : state.selection.ix;
  const data = await apiJson(`/api/jobs/${state.job.id}/line?orientation=${orientation}&index=${index}&range_kind=${rangeKind}`);
  const traces = data.records.map((record, indexRecord) => {
    const isWinner = data.winner && record.ix === data.winner.ix && record.iy === data.winner.iy;
    return {
      type: "scatter", mode: "lines", x: data.frequency_hz, y: record.asd,
      line: { color: isWinner ? "#f1c46a" : lineColor(indexRecord, data.records.length), width: isWinner ? 3 : 1.1 },
      name: `x=${formatNumber(record.x)}, y=${formatNumber(record.y)} · ${formatNumber(record.range_mpc)} Mpc`,
      hovertemplate: "f=%{x:.4g} Hz<br>ASD=%{y:.4g} m/√Hz<extra>%{fullData.name}</extra>",
    };
  });
  if (data.baseline_asd?.some(Number.isFinite)) {
    traces.push({
      type: "scatter", mode: "lines", x: data.frequency_hz, y: data.baseline_asd,
      line: { color: "#f4f6f7", width: 2, dash: "dash" }, name: `Unchanged YAML baseline · ${formatNumber(data.baseline_range_mpc)} Mpc`,
    });
  }
  const fixed = orientation === "horizontal" ? state.result.y[index] : state.result.x[index];
  const fixedLabel = orientation === "horizontal" ? state.result.y_parameter.label : state.result.x_parameter.label;
  const title = `${orientation === "horizontal" ? "Row" : "Column"} at ${fixedLabel} = ${formatNumber(fixed)}`;
  Plotly.react(elements.analysisPlot, traces, {
    ...plotTheme(), title: { text: title, font: { size: 13 } },
    xaxis: { title: "Frequency [Hz]", type: "log", gridcolor: "#26343f" },
    yaxis: { title: "Displacement ASD [m/√Hz]", type: "log", gridcolor: "#26343f" },
    showlegend: elements.showLegend.checked,
    legend: inPlotLegend(),
  }, { responsive: true, displaylogo: false });
  elements.analysisTitle.textContent = "Selected line";
  elements.analysisReadout.textContent = `One full cached spectrum per available grid point. The gold curve has the largest ${rangeKind} BNS range on this line.`;
}

async function renderBestLines() {
  const orientation = elements.lineOrientation.value;
  const rangeKind = state.mapKind === "alternative" ? "alternative" : "standard";
  const data = await apiJson(`/api/jobs/${state.job.id}/winners?orientation=${orientation}&range_kind=${rangeKind}&include_spectra=true`);
  const traces = data.records.filter((record) => record.asd).map((record, index) => ({
    type: "scatter", mode: "lines", x: data.frequency_hz, y: record.asd,
    line: { color: lineColor(index, data.records.length), width: 1.6 },
    name: `x=${formatNumber(record.x)}, y=${formatNumber(record.y)} · ${formatNumber(record.range_mpc)} Mpc`,
  }));
  Plotly.react(elements.analysisPlot, traces, {
    ...plotTheme(), title: { text: `Best spectrum from every ${orientation === "horizontal" ? "row" : "column"}`, font: { size: 13 } },
    xaxis: { title: "Frequency [Hz]", type: "log", gridcolor: "#26343f" },
    yaxis: { title: "Displacement ASD [m/√Hz]", type: "log", gridcolor: "#26343f" },
    showlegend: elements.showLegend.checked,
    legend: inPlotLegend(),
  }, { responsive: true, displaylogo: false });
  elements.analysisTitle.textContent = "Best of every line";
  elements.analysisReadout.textContent = `Each curve is one real cached spectrum at the finite BNS maximum of a ${orientation === "horizontal" ? "row" : "column"}; this is not a frequency-by-frequency envelope.`;
}

async function renderWinningPoints() {
  const orientation = elements.lineOrientation.value;
  const rangeKind = state.mapKind === "alternative" ? "alternative" : "standard";
  const data = await apiJson(`/api/jobs/${state.job.id}/winners?orientation=${orientation}&range_kind=${rangeKind}`);
  const trace = {
    type: "scatter", mode: "markers", x: data.records.map((record) => record.x), y: data.records.map((record) => record.y),
    customdata: data.records.map((record) => [record.ix, record.iy, record.range_mpc]),
    marker: { size: 10, color: data.records.map((record) => record.range_mpc), colorscale: colorscaleFor("map"), showscale: true,
      colorbar: { title: "Range [Mpc]", thickness: 13 } },
    hovertemplate: "x=%{x:.6g}<br>y=%{y:.6g}<br>Range=%{customdata[2]:.6g} Mpc<extra></extra>",
  };
  Plotly.react(elements.analysisPlot, [trace], {
    ...plotTheme(), title: { text: `Winning coordinates from every ${orientation === "horizontal" ? "row" : "column"}`, font: { size: 13 } },
    xaxis: { title: state.result.x_parameter.label, gridcolor: "#26343f" },
    yaxis: { title: state.result.y_parameter.label, gridcolor: "#26343f" },
    showlegend: false,
  }, { responsive: true, displaylogo: false });
  if (elements.analysisPlot.removeAllListeners) elements.analysisPlot.removeAllListeners("plotly_click");
  elements.analysisPlot.on("plotly_click", (event) => {
    const point = event.points?.[0];
    if (!point?.customdata) return;
    state.selection = { ix: point.customdata[0], iy: point.customdata[1] };
    state.analysisKind = "line";
    setActiveAnalysisTab();
    renderMap();
    renderAnalysis();
  });
  elements.analysisTitle.textContent = "Winning X/Y";
  elements.analysisReadout.textContent = "Click a marker to select that winning line on the map and inspect its spectra.";
}

async function renderAnalysis() {
  if (!state.result || !state.job) return;
  try {
    if (state.analysisKind === "best") await renderBestLines();
    else if (state.analysisKind === "points") await renderWinningPoints();
    else await renderSelectedLine();
  } catch (error) {
    elements.analysisReadout.textContent = `Could not load cached spectra: ${error.message}`;
  }
}

function setActiveMapTab() {
  $$(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.map === state.mapKind));
}

function setActiveAnalysisTab() {
  $$(".analysis-tab").forEach((button) => button.classList.toggle("active", button.dataset.analysis === state.analysisKind));
}

function renderResult() {
  elements.mismatchTab.disabled = !state.result.sqz_ifo_mismatch_percent;
  if (state.mapKind === "mismatch" && elements.mismatchTab.disabled) state.mapKind = "standard";
  setActiveMapTab();
  setActiveAnalysisTab();
  renderMap();
  renderAnalysis();
  const metadata = state.result.metadata;
  elements.conventionNote.textContent = metadata.range_convention;
  elements.timingNote.textContent = `${state.result.elapsed_s.toFixed(2)} s calculation time; cached spectra remain on the server for linecuts and reweighting.`;
  elements.errorsNote.textContent = state.result.errors.length ? `${state.result.errors.length} baseline or grid errors; their cells remain blank.` : "No baseline or grid errors reported.";
  elements.resultNotes.hidden = false;
}

async function downloadResults() {
  if (!state.job || !state.result) return;
  try {
    const response = await api(`/api/jobs/${state.job.id}/download`);
    const blob = await response.blob();
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `bns_sweep_${state.job.id.slice(0, 8)}.npz`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(anchor.href);
  } catch (error) {
    setJobPanel("Could not download results", error.message);
  }
}

function resizePlots() {
  if (!window.Plotly) return;
  [elements.mapPlot, elements.analysisPlot].forEach((element) => Plotly.Plots.resize(element));
}

function bindEvents() {
  elements.apiBase.value = initialApiBase();
  state.apiBase = normalizeBase(elements.apiBase.value);
  syncColorscaleControl();
  elements.checkServer.addEventListener("click", checkServer);
  elements.apiBase.addEventListener("change", () => { state.apiBase = normalizeBase(elements.apiBase.value); });
  elements.token.addEventListener("input", () => { state.token = elements.token.value.trim(); });
  elements.yamlFile.addEventListener("change", () => loadYamlFile(elements.yamlFile.files[0]));
  elements.xParameter.addEventListener("change", () => { setAxisDefaults("x"); renderParameterEditor(); updateGridReadout(); });
  elements.yParameter.addEventListener("change", () => { setAxisDefaults("y"); renderParameterEditor(); updateGridReadout(); });
  [elements.xPoints, elements.yPoints].forEach((element) => element.addEventListener("input", updateGridReadout));
  elements.parameterFilter.addEventListener("input", renderParameterEditor);
  elements.colorscaleTarget.addEventListener("change", syncColorscaleControl);
  elements.mapColorscale.addEventListener("change", () => {
    state.colorscales[elements.colorscaleTarget.value] = elements.mapColorscale.value;
    renderMap();
    renderAnalysis();
  });
  elements.lineOrientation.addEventListener("change", () => { renderMap(); renderAnalysis(); });
  elements.showWinners.addEventListener("change", renderMap);
  elements.showLegend.addEventListener("change", renderAnalysis);
  elements.run.addEventListener("click", runSweep);
  elements.cancel.addEventListener("click", cancelSweep);
  elements.download.addEventListener("click", downloadResults);
  $$(".tab-button").forEach((button) => button.addEventListener("click", () => {
    if (button.disabled) return;
    state.mapKind = button.dataset.map;
    setActiveMapTab();
    renderMap();
    renderAnalysis();
  }));
  $$(".analysis-tab").forEach((button) => button.addEventListener("click", () => {
    state.analysisKind = button.dataset.analysis;
    setActiveAnalysisTab();
    renderAnalysis();
  }));
  $("#hide-controls").addEventListener("click", () => { elements.app.classList.add("controls-hidden"); setTimeout(resizePlots, 220); });
  $("#show-controls").addEventListener("click", () => { elements.app.classList.remove("controls-hidden"); setTimeout(resizePlots, 220); });
  window.addEventListener("resize", resizePlots);
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  setInputsEnabled(false);
  setJobPanel("Ready", "Load a YAML model, choose axes, then start a sweep.");
  window.setTimeout(() => { if (state.apiBase) checkServer(); }, 250);
});
