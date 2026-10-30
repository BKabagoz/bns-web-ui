/* Browser client for the local quantum-noise BNS calculation service.
 * The client is deliberately static: it can be deployed unchanged to GitHub
 * Pages, while all GWINC work and retained spectra live on the compute server.
 */

const state = {
  apiBase: "",
  token: "",
  serverConnected: false,
  defaultYamlText: "",
  defaultYamlName: "Built-in BNS example",
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

const DEFAULT_MODEL_URL = "examples/default.yaml";
const SPEED_OF_LIGHT_M_S = 299792458;
const FC_LINEWIDTH_PATHS = {
  length: ["Squeezer", "FilterCavity", "L"],
  inputTransmission: ["Squeezer", "FilterCavity", "Ti"],
  endTransmission: ["Squeezer", "FilterCavity", "Te"],
  roundTripLoss: ["Squeezer", "FilterCavity", "Lrt"],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const elements = {
  app: $("#application"), controls: $("#controls"), apiBase: $("#api-base"), token: $("#access-token"),
  serverStatus: $("#server-status"), checkServer: $("#check-server"), yamlFile: $("#yaml-file"), loadDefaultModel: $("#load-default-model"),
  yamlStatus: $("#yaml-status"), xParameter: $("#x-parameter"), yParameter: $("#y-parameter"),
  xMinimum: $("#x-minimum"), xMaximum: $("#x-maximum"), xPoints: $("#x-points"),
  yMinimum: $("#y-minimum"), yMaximum: $("#y-maximum"), yPoints: $("#y-points"),
  gridReadout: $("#grid-readout"), parameterEditor: $("#parameter-editor"),
  parameterFilter: $("#parameter-filter"), overrideCount: $("#override-count"),
  fcLinewidth: $("#fc-linewidth"), fcLinewidthValue: $("#fc-linewidth-value"), fcLinewidthNote: $("#fc-linewidth-note"),
  fmin: $("#fmin"), fmax: $("#fmax"), frequencyPoints: $("#frequency-points"),
  outputCalibration: $("#output-calibration"), altMass1: $("#alternative-mass-1"), altMass2: $("#alternative-mass-2"),
  reweightPanel: $("#reweight-panel"), reweightMass1: $("#reweight-mass-1"), reweightMass2: $("#reweight-mass-2"),
  reweightResults: $("#reweight-results"), reweightNote: $("#reweight-note"),
  colorscaleTarget: $("#colorscale-target"), mapColorscale: $("#map-colorscale"), lineOrientation: $("#line-orientation"),
  showWinners: $("#show-winners"), showLegend: $("#show-legend"), showFcAxis: $("#show-fc-axis"), showFcAxisLabel: $("#show-fc-axis-label"), figureTheme: $("#figure-theme"), figureFontSize: $("#figure-font-size"), run: $("#run-sweep"), cancel: $("#cancel-sweep"),
  download: $("#download-results"), downloadMapCsv: $("#download-map-csv"), downloadMapPng: $("#download-map-png"),
  downloadAnalysisCsv: $("#download-analysis-csv"), downloadAnalysisPng: $("#download-analysis-png"),
  jobTitle: $("#job-title"), jobMessage: $("#job-message"),
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
    state.serverConnected = true;
    const suffix = health.gwinc_version ? ` GWINC ${health.gwinc_version} is available.` : " GWINC is not installed yet.";
    setServerStatus(`Connected. ${health.worker_concurrency} calculation worker${health.worker_concurrency === 1 ? "" : "s"}.${suffix}`, health.gwinc_version ? "ok" : "problem");
    if (!state.yamlText && state.defaultYamlText) loadDefaultModel();
  } catch (error) {
    state.serverConnected = false;
    setServerStatus(`Could not reach the compute server: ${error.message}`, "problem");
  }
}

function setInputsEnabled(enabled) {
  [elements.xParameter, elements.yParameter, elements.xMinimum, elements.xMaximum, elements.xPoints,
   elements.yMinimum, elements.yMaximum, elements.yPoints].forEach((element) => { element.disabled = !enabled; });
  elements.run.disabled = !enabled;
}

function setDownloadsEnabled(enabled) {
  [elements.download, elements.downloadMapCsv, elements.downloadMapPng,
   elements.downloadAnalysisCsv, elements.downloadAnalysisPng]
    .forEach((element) => { element.disabled = !enabled; });
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
  updateFcLinewidth();
  updateFcAxisControl();
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
      updateFcLinewidth();
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

function parameterDefault(path) {
  return Number(state.parameters.find((parameter) => samePath(parameter.path, path))?.default);
}

function configuredFcValues() {
  const values = {};
  Object.entries(FC_LINEWIDTH_PATHS).forEach(([name, path]) => {
    const raw = state.overrides.get(JSON.stringify(path));
    values[name] = raw === undefined || raw === "" ? parameterDefault(path) : Number(raw);
  });
  return values;
}

function fcHalfLinewidthHz(values) {
  const { length, inputTransmission, endTransmission, roundTripLoss } = values;
  const totalLoss = inputTransmission + endTransmission + roundTripLoss;
  if (![length, inputTransmission, endTransmission, roundTripLoss, totalLoss].every(Number.isFinite)
      || length <= 0 || totalLoss <= 0) return NaN;
  return SPEED_OF_LIGHT_M_S * totalLoss / (4 * Math.PI * length);
}

function fcSweepValues() {
  const configured = configuredFcValues();
  const relevantAxes = [];
  [[elements.xParameter, elements.xMinimum, elements.xMaximum], [elements.yParameter, elements.yMinimum, elements.yMaximum]]
    .forEach(([select, minimum, maximum]) => {
      let path;
      try { path = pathFor(select); } catch (_) { return; }
      const field = Object.entries(FC_LINEWIDTH_PATHS).find(([, candidate]) => samePath(candidate, path));
      if (!field) return;
      const low = Number(minimum.value);
      const high = Number(maximum.value);
      if (!Number.isFinite(low) || !Number.isFinite(high)) return;
      relevantAxes.push({ field: field[0], values: [low, high] });
    });
  const combinations = [{}];
  relevantAxes.forEach(({ field, values }) => {
    const next = [];
    combinations.forEach((combination) => values.forEach((value) => next.push({ ...combination, [field]: value })));
    combinations.splice(0, combinations.length, ...next);
  });
  return { relevantAxes, widths: combinations.map((update) => fcHalfLinewidthHz({ ...configured, ...update })) };
}

function fcSweepField(select) {
  try {
    const path = pathFor(select);
    return Object.entries(FC_LINEWIDTH_PATHS).find(([, candidate]) => samePath(candidate, path))?.[0] || null;
  } catch (_) {
    return null;
  }
}

function updateFcAxisControl() {
  const fields = [fcSweepField(elements.xParameter), fcSweepField(elements.yParameter)].filter(Boolean);
  const available = fields.length === 1;
  elements.showFcAxis.disabled = !available;
  if (!available) elements.showFcAxis.checked = false;
  elements.showFcAxisLabel.title = available
    ? "Add a secondary axis labeled with the corresponding filter-cavity HWHM."
    : "Select exactly one filter-cavity linewidth input (L, Ti, Te, or Lrt) as an axis to enable this option.";
}

function resultAxisParameter(axis) {
  return axis === "x" ? state.result.x_parameter : state.result.y_parameter;
}

function coordinateText(xValue, yValue, { separator = ", " } = {}) {
  return `${resultAxisParameter("x").label} = ${formatNumber(xValue)}${separator}${resultAxisParameter("y").label} = ${formatNumber(yValue)}`;
}

function fcLinewidthAxisLayout() {
  if (!state.result || !elements.showFcAxis.checked) return { axes: {}, x: false, y: false };
  const xField = fcSweepField(elements.xParameter);
  const yField = fcSweepField(elements.yParameter);
  if (Boolean(xField) === Boolean(yField)) return { axes: {}, x: false, y: false };
  const axis = xField ? "x" : "y";
  const field = xField || yField;
  const values = state.result[axis];
  const configured = configuredFcValues();
  const indices = [...new Set([0, Math.round((values.length - 1) * .25), Math.round((values.length - 1) * .5), Math.round((values.length - 1) * .75), values.length - 1])];
  const tickvals = indices.map((index) => values[index]);
  const ticktext = indices.map((index) => formatNumber(fcHalfLinewidthHz({ ...configured, [field]: values[index] }), 4));
  const secondary = {
    overlaying: axis, side: axis === "x" ? "top" : "right", title: { text: "FC HWHM [Hz]", font: { color: "#84d6bf", size: Math.max(10, figureFontSize() - 1) } },
    tickmode: "array", tickvals, ticktext, showgrid: false, zeroline: false, ticks: "outside",
    range: [Math.min(...values), Math.max(...values)], anchor: "free", position: 1,
    visible: true, showticklabels: true, showline: true, linecolor: "#84d6bf", linewidth: 1.2,
    tickcolor: "#84d6bf", ticklen: 5, fixedrange: true,
    tickfont: { color: "#84d6bf", size: Math.max(9, figureFontSize() - 2) },
  };
  return { axes: { [axis === "x" ? "xaxis2" : "yaxis2"]: secondary }, x: axis === "x", y: axis === "y" };
}

function updateFcLinewidth() {
  if (!state.parameters.length) {
    elements.fcLinewidth.hidden = true;
    return;
  }
  const { relevantAxes, widths } = fcSweepValues();
  if (!relevantAxes.length) {
    elements.fcLinewidth.hidden = true;
    return;
  }
  const finiteWidths = widths.filter(Number.isFinite);
  if (!finiteWidths.length) {
    elements.fcLinewidth.hidden = false;
    elements.fcLinewidthValue.textContent = "Cannot calculate";
    elements.fcLinewidthNote.textContent = "Filter-cavity length and total loss must be positive finite values.";
    return;
  }
  const low = Math.min(...finiteWidths);
  const high = Math.max(...finiteWidths);
  const isRange = Math.abs(high - low) > Math.max(1e-10, Math.abs(high) * 1e-9);
  elements.fcLinewidth.hidden = false;
  elements.fcLinewidthValue.textContent = isRange
    ? `${formatNumber(low, 4)}–${formatNumber(high, 4)} Hz HWHM`
    : `${formatNumber(low, 4)} Hz HWHM`;
  elements.fcLinewidthNote.textContent = `${isRange ? "Across this sweep; " : ""}FWHM ${formatNumber(2 * low, 4)}${isRange ? `–${formatNumber(2 * high, 4)}` : ""} Hz. γ = c(Ti + Te + Lrt)/(4πL).`;
}

async function loadYamlText(yamlText, yamlName) {
  state.yamlText = yamlText;
  state.yamlName = yamlName;
  elements.yamlStatus.textContent = `Reading ${yamlName}…`;
  try {
    const response = await apiJson("/api/model/parameters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ yaml_text: state.yamlText }),
    });
    state.overrides.clear();
    populateParameters(response.parameters);
    elements.yamlStatus.textContent = `${yamlName}: ${response.parameters.length} finite numeric fields are available.`;
    setJobPanel("Model loaded", "Choose axes and submit a calculation when ready.");
  } catch (error) {
    state.yamlText = "";
    state.parameters = [];
    setInputsEnabled(false);
    updateFcLinewidth();
    updateFcAxisControl();
    elements.yamlStatus.textContent = `Could not load this YAML: ${error.message}`;
    setJobPanel("Model not loaded", error.message);
  }
}

async function loadYamlFile(file) {
  if (!file) return;
  await loadYamlText(await file.text(), file.name);
}

async function prepareDefaultModel() {
  try {
    const response = await fetch(DEFAULT_MODEL_URL);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    state.defaultYamlText = await response.text();
    if (!state.yamlText) elements.yamlStatus.textContent = "Built-in example is ready. Connect to the compute server to load it.";
    if (state.serverConnected && !state.yamlText) loadDefaultModel();
  } catch (error) {
    elements.loadDefaultModel.disabled = true;
    elements.yamlStatus.textContent = `Could not fetch the built-in example: ${error.message}`;
  }
}

async function loadDefaultModel() {
  if (!state.defaultYamlText) {
    await prepareDefaultModel();
    if (!state.defaultYamlText) return;
  }
  if (!state.serverConnected) {
    elements.yamlStatus.textContent = "Connect to the compute server before loading the built-in example.";
    return;
  }
  await loadYamlText(state.defaultYamlText, state.defaultYamlName);
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
    setDownloadsEnabled(false);
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
    setDownloadsEnabled(true);
    const alternative = state.result.metadata.alternative_range;
    elements.reweightPanel.hidden = false;
    elements.reweightMass1.value = alternative.mass1_msun;
    elements.reweightMass2.value = alternative.mass2_msun;
    [elements.reweightMass1, elements.reweightMass2, elements.reweightResults].forEach((element) => { element.disabled = false; });
    elements.reweightNote.textContent = "Reintegrate the cached spectra for a new binary. No additional GWINC calls are made.";
    renderResult();
    setJobPanel("Complete", `Calculated ${state.result.completed_points.toLocaleString()} grid points in ${state.result.elapsed_s.toFixed(1)} s.`, state.result.completed_points, state.result.total_points);
  } catch (error) {
    elements.run.disabled = false;
    setJobPanel("Could not load result", error.message);
  }
}

async function reweightResults() {
  if (!state.job || !state.result) return;
  try {
    const mass1 = numberValue(elements.reweightMass1, "Reweight mass 1");
    const mass2 = numberValue(elements.reweightMass2, "Reweight mass 2");
    if (mass1 <= 0 || mass2 <= 0) throw new Error("Both reweighting masses must be positive.");
    elements.reweightResults.disabled = true;
    elements.reweightNote.textContent = "Reweighting cached spectra…";
    const response = await apiJson(`/api/jobs/${state.job.id}/reweight`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mass1_msun: mass1, mass2_msun: mass2 }),
    });
    state.result.alternative_range_mpc = response.range_mpc;
    if (response.baseline_range_mpc !== undefined) state.result.baseline_alternative_range_mpc = response.baseline_range_mpc;
    state.result.metadata.alternative_range = response.metadata || {
      ...state.result.metadata.alternative_range, mass1_msun: mass1, mass2_msun: mass2,
    };
    state.mapKind = "alternative";
    setActiveMapTab();
    renderMap();
    renderAnalysis();
    elements.reweightNote.textContent = response.metadata
      ? `${mass1} + ${mass2} M⊙ applied. ${response.message}`
      : `${mass1} + ${mass2} M⊙ applied to this map. Restart the laptop backend with the updated files to reweight line winners too.`;
  } catch (error) {
    elements.reweightNote.textContent = `Could not reweight: ${error.message}`;
  } finally {
    elements.reweightResults.disabled = false;
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

function figureColors() {
  return elements.figureTheme.value === "light"
    ? { paper: "#ffffff", plot: "#ffffff", ink: "#17232c", grid: "#d7e0e5", zero: "#b5c3cb", hover: "#ffffff", hoverInk: "#17232c", legend: "rgba(255,255,255,.9)", outline: "#25333e" }
    : { paper: "#111a22", plot: "#111a22", ink: "#dce6ea", grid: "#26343f", zero: "#344651", hover: "#081016", hoverInk: "#edf3f5", legend: "rgba(8,16,22,.82)", outline: "#f3f6f7" };
}

function figureFontSize() {
  const value = Number(elements.figureFontSize.value);
  return Number.isFinite(value) ? Math.max(8, Math.min(20, value)) : 11;
}

function figureAxis(title, extra = {}) {
  const colors = figureColors();
  const isLog = extra.type === "log";
  return {
    title, gridcolor: colors.grid, zerolinecolor: colors.zero, automargin: false,
    showline: true, mirror: true, linecolor: colors.zero, linewidth: 1,
    ...(isLog ? { dtick: 1, minor: { showgrid: true, gridcolor: colors.grid, ticks: "" } } : {}),
    ...extra,
  };
}

function figureMargins(kind) {
  // Fixed generous margins keep the usable plot rectangle stable while users
  // switch themes, font sizes, map layers, or the FC secondary axis.
  return kind === "map"
    ? { l: 76, r: 150, t: 22, b: 56 }
    : { l: 88, r: 62, t: 72, b: 74 };
}

function fcAxisAnchorTrace(x, y, fcAxis) {
  if (fcAxis.x) return {
    type: "scatter", mode: "markers", x: [x[0]], y: [y[0]], xaxis: "x2",
    marker: { opacity: 0 }, hoverinfo: "skip", showlegend: false,
  };
  if (fcAxis.y) return {
    type: "scatter", mode: "markers", x: [x[0]], y: [y[0]], yaxis: "y2",
    marker: { opacity: 0 }, hoverinfo: "skip", showlegend: false,
  };
  return null;
}

function plotTheme() {
  const colors = figureColors();
  return {
    paper_bgcolor: colors.paper, plot_bgcolor: colors.plot, font: { color: colors.ink, size: figureFontSize() },
    margin: figureMargins("analysis"), hoverlabel: { bgcolor: colors.hover, font: { color: colors.hoverInk } },
  };
}

function insideSweep(value, samples) {
  const lower = Math.min(...samples);
  const upper = Math.max(...samples);
  return Number.isFinite(value) && lower <= value && value <= upper;
}

function inPlotLegend() {
  const colors = figureColors();
  return {
    x: 0.985, y: 0.985, xanchor: "right", yanchor: "top",
    font: { size: Math.max(8, figureFontSize() - 2), color: colors.ink }, bgcolor: colors.legend,
    bordercolor: colors.grid, borderwidth: 1,
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
  const xLabel = escapeText(state.result.x_parameter.label);
  const yLabel = escapeText(state.result.y_parameter.label);
  const colors = figureColors();
  const defaultInside = insideSweep(defaultX, x) && insideSweep(defaultY, y);
  const traces = [{
    type: "heatmap", x, y, z: info.grid, colorscale: colorscaleFor("map"),
    colorbar: { title: { text: info.colorTitle, side: "right" }, thickness: 13, x: 1.17 },
    hovertemplate: `${xLabel}: %{x:.6g}<br>${yLabel}: %{y:.6g}<br>${info.colorTitle}: %{z:.6g}<extra></extra>`,
  }];
  if (elements.showWinners.checked && state.mapKind !== "mismatch") {
    const points = winners(info.grid, horizontal);
    traces.push({
      type: "scatter", mode: "markers", x: points.map((point) => x[point.ix]), y: points.map((point) => y[point.iy]),
      marker: { size: 9, color: "rgba(255,255,255,0)", line: { color: colors.outline, width: 1.35 } },
      hovertemplate: `Line winner<br>${xLabel}: %{x:.6g}<br>${yLabel}: %{y:.6g}<extra></extra>`, name: "Line winners",
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
      marker: { symbol: "square-open", size: 15, color: colors.outline, line: { color: colors.outline, width: 2 } },
      hovertemplate: `Unchanged YAML operating point<br>${xLabel}: %{x:.6g}<br>${yLabel}: %{y:.6g}<extra></extra>`,
      showlegend: false, name: "YAML operating point",
    });
  }
  const fcAxis = fcLinewidthAxisLayout();
  const fcAnchor = fcAxisAnchorTrace(x, y, fcAxis);
  if (fcAnchor) traces.push(fcAnchor);
  const theme = plotTheme();
  const layout = {
    ...theme, ...fcAxis.axes, margin: figureMargins("map"),
    xaxis: figureAxis(state.result.x_parameter.label),
    yaxis: figureAxis(state.result.y_parameter.label),
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
    : `The YAML operating point (${coordinateText(defaultX, defaultY)}) is outside this sweep.`;
  if (state.mapKind === "mismatch") {
    elements.mapReadout.textContent = `Derived coherent two-mode SQZ–IFO mismatch in the common OMC basis. It uses no additional GWINC calls.${elements.showFcAxis.checked ? " Green secondary ticks show FC HWHM." : ""} ${operatingPointNote}`;
  } else {
    const selected = info.grid[state.selection.iy]?.[state.selection.ix];
    elements.mapReadout.textContent = `Selected: ${coordinateText(x[state.selection.ix], y[state.selection.iy])}, range = ${formatNumber(selected)} Mpc.${elements.showFcAxis.checked ? " Green secondary ticks show FC HWHM." : ""} Click a cell to change the selected line. ${operatingPointNote}`;
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
      name: `${coordinateText(record.x, record.y, { separator: " · " })} · ${formatNumber(record.range_mpc)} Mpc`,
      hovertemplate: "f=%{x:.4g} Hz<br>ASD=%{y:.4g} m/√Hz<extra>%{fullData.name}</extra>",
    };
  });
  if (data.baseline_asd?.some(Number.isFinite)) {
    traces.push({
      type: "scatter", mode: "lines", x: data.frequency_hz, y: data.baseline_asd,
      line: { color: figureColors().outline, width: 2, dash: "dash" }, name: `Unchanged YAML baseline · ${formatNumber(data.baseline_range_mpc)} Mpc`,
    });
  }
  const fixed = orientation === "horizontal" ? state.result.y[index] : state.result.x[index];
  const fixedLabel = orientation === "horizontal" ? state.result.y_parameter.label : state.result.x_parameter.label;
  const title = `${orientation === "horizontal" ? "Row" : "Column"} at ${fixedLabel} = ${formatNumber(fixed)}`;
  Plotly.react(elements.analysisPlot, traces, {
    ...plotTheme(), title: { text: title, font: { size: figureFontSize() } },
    xaxis: figureAxis("Frequency [Hz]", { type: "log" }),
    yaxis: figureAxis("Displacement ASD [m/√Hz]", { type: "log" }),
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
    name: `${coordinateText(record.x, record.y, { separator: " · " })} · ${formatNumber(record.range_mpc)} Mpc`,
  }));
  Plotly.react(elements.analysisPlot, traces, {
    ...plotTheme(), title: { text: `Best spectrum from every ${orientation === "horizontal" ? "row" : "column"}`, font: { size: figureFontSize() } },
    xaxis: figureAxis("Frequency [Hz]", { type: "log" }),
    yaxis: figureAxis("Displacement ASD [m/√Hz]", { type: "log" }),
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
    hovertemplate: `${escapeText(state.result.x_parameter.label)} = %{x:.6g}<br>${escapeText(state.result.y_parameter.label)} = %{y:.6g}<br>Range = %{customdata[2]:.6g} Mpc<extra></extra>`,
  };
  const fcAxis = fcLinewidthAxisLayout();
  const fcAnchor = fcAxisAnchorTrace(trace.x, trace.y, fcAxis);
  const traces = fcAnchor ? [trace, fcAnchor] : [trace];
  const theme = plotTheme();
  Plotly.react(elements.analysisPlot, traces, {
    ...theme, ...fcAxis.axes, margin: figureMargins("map"), title: { text: `Winning coordinates from every ${orientation === "horizontal" ? "row" : "column"}`, font: { size: figureFontSize() } },
    xaxis: figureAxis(state.result.x_parameter.label),
    yaxis: figureAxis(state.result.y_parameter.label),
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
    downloadBlob(`bns_sweep_${state.job.id.slice(0, 8)}.npz`, blob);
  } catch (error) {
    setJobPanel("Could not download results", error.message);
  }
}

function downloadBlob(filename, blob) {
  const anchor = document.createElement("a");
  const objectUrl = URL.createObjectURL(blob);
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

function csvCell(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && !Number.isFinite(value)) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function downloadCsv(filename, headers, rows) {
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  downloadBlob(filename, new Blob([csv], { type: "text/csv;charset=utf-8" }));
}

function resultFileStem(suffix) {
  return `bns_sweep_${state.job?.id?.slice(0, 8) || "results"}_${suffix}`;
}

function downloadMapCsv() {
  if (!state.result) return;
  const { x, y, x_parameter: xParameter, y_parameter: yParameter } = state.result;
  const rows = [];
  y.forEach((yValue, iy) => x.forEach((xValue, ix) => rows.push([
    xValue,
    yValue,
    state.result.range_mpc?.[iy]?.[ix],
    state.result.alternative_range_mpc?.[iy]?.[ix],
    state.result.sqz_ifo_mismatch_percent?.[iy]?.[ix],
  ])));
  downloadCsv(`${resultFileStem("maps")}.csv`, [
    `${xParameter.label} (x)`,
    `${yParameter.label} (y)`,
    "standard_range_mpc",
    "alternative_range_mpc",
    "sqz_ifo_mismatch_percent",
  ], rows);
}

function downloadAnalysisCsv() {
  if (!state.result) return;
  const traces = Array.from(elements.analysisPlot.data || []);
  if (!traces.length) {
    setJobPanel("Analysis plot not ready", "Wait for the selected analysis view to finish loading, then try again.");
    return;
  }
  if (state.analysisKind === "points") {
    const trace = traces[0];
    const rows = Array.from(trace.x || []).map((xValue, index) => [
      xValue,
      trace.y?.[index],
      trace.customdata?.[index]?.[2],
    ]);
    downloadCsv(`${resultFileStem("winning_coordinates")}.csv`, [
      `${state.result.x_parameter.label} (x)`,
      `${state.result.y_parameter.label} (y)`,
      "range_mpc",
    ], rows);
    return;
  }
  const rowCount = Math.max(...traces.map((trace) => trace.y?.length || 0));
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const frequency = traces.find((trace) => trace.x?.[index] !== undefined)?.x?.[index];
    return [frequency, ...traces.map((trace) => trace.y?.[index])];
  });
  downloadCsv(`${resultFileStem(state.analysisKind === "best" ? "best_asd" : "selected_line_asd")}.csv`, [
    "frequency_hz",
    ...traces.map((trace, index) => trace.name || `asd_${index + 1}`),
  ], rows);
}

async function downloadPlotImage(element, suffix) {
  if (!state.result || !window.Plotly || !element.data?.length) {
    setJobPanel("Plot not ready", "Wait for the plot to finish rendering, then try again.");
    return;
  }
  try {
    await Plotly.downloadImage(element, { format: "png", filename: resultFileStem(suffix), scale: 2 });
  } catch (error) {
    setJobPanel("Could not download plot", error.message);
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
  elements.loadDefaultModel.addEventListener("click", loadDefaultModel);
  elements.xParameter.addEventListener("change", () => { setAxisDefaults("x"); renderParameterEditor(); updateGridReadout(); updateFcLinewidth(); updateFcAxisControl(); });
  elements.yParameter.addEventListener("change", () => { setAxisDefaults("y"); renderParameterEditor(); updateGridReadout(); updateFcLinewidth(); updateFcAxisControl(); });
  [elements.xMinimum, elements.xMaximum, elements.yMinimum, elements.yMaximum].forEach((element) => element.addEventListener("input", updateFcLinewidth));
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
  elements.showFcAxis.addEventListener("change", () => { renderMap(); renderAnalysis(); });
  elements.figureTheme.addEventListener("change", () => { renderMap(); renderAnalysis(); });
  elements.figureFontSize.addEventListener("input", () => { renderMap(); renderAnalysis(); });
  elements.run.addEventListener("click", runSweep);
  elements.cancel.addEventListener("click", cancelSweep);
  elements.reweightResults.addEventListener("click", reweightResults);
  elements.download.addEventListener("click", downloadResults);
  elements.downloadMapCsv.addEventListener("click", downloadMapCsv);
  elements.downloadMapPng.addEventListener("click", () => downloadPlotImage(elements.mapPlot, `${state.mapKind}_map`));
  elements.downloadAnalysisCsv.addEventListener("click", downloadAnalysisCsv);
  elements.downloadAnalysisPng.addEventListener("click", () => downloadPlotImage(elements.analysisPlot, `${state.analysisKind}_analysis`));
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
  prepareDefaultModel();
  window.setTimeout(() => { if (state.apiBase) checkServer(); }, 250);
});
