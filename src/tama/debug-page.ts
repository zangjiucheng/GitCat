import { createTama3DDebugActor, type TamaDebugRotation } from "./three-actor";
import { TAMA_STATES, type TamaState } from "./types";
import "./debug-page.css";

const STATE_LABELS: Record<TamaState, string> = {
  idle: "待机",
  sleep: "睡觉",
  hint: "提示",
  thinking: "思考",
  warn: "警告",
  danger: "危险",
  celebrate: "庆祝",
  rescue: "救援",
  confused: "困惑",
  curious: "好奇",
  syncing: "同步",
  greeting: "挥手",
};

const QUICK_BONES = [
  ["頭", "头"],
  ["首", "颈部"],
  ["上半身2", "上身"],
  ["左肩", "左肩"],
  ["左腕", "左上臂"],
  ["左ひじ", "左肘"],
  ["左手首", "左手腕"],
  ["右肩", "右肩"],
  ["右腕", "右上臂"],
  ["右ひじ", "右肘"],
  ["右手首", "右手腕"],
  ["左人指１", "左食指"],
  ["右人指１", "右食指"],
  ["左TJ_0_1", "左猫耳"],
  ["右TJ_0_1", "右猫耳"],
  ["右W_1", "尾巴根"],
  ["左W_1", "左尾巴"],
  ["右W_3", "右尾巴"],
] as const;

const AXES = ["x", "y", "z"] as const;
type Axis = (typeof AXES)[number];

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing debug control #${id}`);
  return found as T;
}

const modelMount = element<HTMLDivElement>("model");
const stateSelect = element<HTMLSelectElement>("state");
const boneSelect = element<HTMLSelectElement>("bone");
const stateButtons = element<HTMLDivElement>("stateButtons");
const quickBones = element<HTMLDivElement>("quickBones");
const axisControls = element<HTMLDivElement>("axisControls");
const marker = element<HTMLInputElement>("marker");
const note = element<HTMLTextAreaElement>("note");
const report = element<HTMLPreElement>("report");
const copyStatus = element<HTMLDivElement>("copyStatus");
const stateReadout = element<HTMLSpanElement>("stateReadout");
const boneReadout = element<HTMLSpanElement>("boneReadout");

const actor = createTama3DDebugActor({
  mount: modelMount,
  onUnavailable: () => {
    modelMount.dataset.error = "true";
    modelMount.textContent = "模型载入失败";
  },
});

const ranges = new Map<Axis, HTMLInputElement>();
const numbers = new Map<Axis, HTMLInputElement>();
let state: TamaState = "idle";
let bone = "左肩";

function currentRotation(): TamaDebugRotation {
  return actor.getDebugBoneOffset(bone);
}

function format(value: number): string {
  return value.toFixed(2);
}

function updateUrl(): void {
  const url = new URL(location.href);
  url.searchParams.set("state", state);
  url.searchParams.set("bone", bone);
  history.replaceState(null, "", url);
}

function reportText(): string {
  const rotation = currentRotation();
  const problem = note.value.trim() || "（未填写）";
  return [
    "Tama 关节问题",
    `动作: ${state} (${STATE_LABELS[state]})`,
    `关节: ${bone}`,
    `偏移: X ${format(rotation.x)} / Y ${format(rotation.y)} / Z ${format(rotation.z)} rad`,
    `备注: ${problem}`,
  ].join("\n");
}

function refreshReport(): void {
  report.textContent = reportText();
  stateReadout.textContent = `动作 ${state} · ${STATE_LABELS[state]}`;
  boneReadout.textContent = `关节 ${bone}`;
  updateUrl();
}

function refreshAxes(): void {
  const rotation = currentRotation();
  for (const axis of AXES) {
    const value = format(rotation[axis]);
    const range = ranges.get(axis);
    const number = numbers.get(axis);
    if (range) range.value = value;
    if (number) number.value = value;
  }
  refreshReport();
}

function setAxis(axis: Axis, value: number): void {
  const rotation = currentRotation();
  rotation[axis] = value;
  actor.setDebugBoneOffset(bone, rotation);
  refreshAxes();
}

function selectState(next: TamaState): void {
  state = next;
  stateSelect.value = next;
  actor.setState(next);
  for (const button of stateButtons.querySelectorAll<HTMLButtonElement>("button")) {
    button.dataset.active = String(button.dataset.state === next);
  }
  refreshReport();
}

function selectBone(next: string): void {
  bone = next;
  boneSelect.value = next;
  actor.selectDebugBone(next);
  for (const button of quickBones.querySelectorAll<HTMLButtonElement>("button")) {
    button.dataset.active = String(button.dataset.bone === next);
  }
  refreshAxes();
}

for (const value of TAMA_STATES) {
  stateSelect.add(new Option(`${value} · ${STATE_LABELS[value]}`, value));
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.state = value;
  button.innerHTML = `<span>${STATE_LABELS[value]}</span><small>${value}</small>`;
  button.addEventListener("click", () => selectState(value));
  stateButtons.append(button);
}

for (const [name, label] of QUICK_BONES) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.bone = name;
  button.textContent = label;
  button.addEventListener("click", () => selectBone(name));
  quickBones.append(button);
}

for (const axis of AXES) {
  const row = document.createElement("div");
  row.className = `axis-row axis-${axis}`;
  const label = document.createElement("label");
  label.htmlFor = `axis-${axis}`;
  label.textContent = axis.toUpperCase();
  const range = document.createElement("input");
  range.id = `axis-${axis}`;
  range.type = "range";
  range.min = "-3.14";
  range.max = "3.14";
  range.step = "0.01";
  const number = document.createElement("input");
  number.type = "number";
  number.min = "-3.14";
  number.max = "3.14";
  number.step = "0.01";
  number.setAttribute("aria-label", `${axis.toUpperCase()} rotation in radians`);
  range.addEventListener("input", () => setAxis(axis, Number(range.value)));
  number.addEventListener("input", () => setAxis(axis, Number(number.value) || 0));
  row.append(label, range, number);
  ranges.set(axis, range);
  numbers.set(axis, number);
  axisControls.append(row);
}

stateSelect.addEventListener("change", () => selectState(stateSelect.value as TamaState));
boneSelect.addEventListener("change", () => selectBone(boneSelect.value));
marker.addEventListener("change", () => actor.setDebugMarkerVisible(marker.checked));
note.addEventListener("input", refreshReport);
element<HTMLButtonElement>("resetBone").addEventListener("click", () => {
  actor.resetDebugBone(bone);
  refreshAxes();
});
element<HTMLButtonElement>("resetAll").addEventListener("click", () => {
  actor.resetAllDebugBones();
  refreshAxes();
});
element<HTMLButtonElement>("copyReport").addEventListener("click", async () => {
  await navigator.clipboard.writeText(reportText());
  copyStatus.textContent = "已复制，可以直接粘贴给我。";
  window.setTimeout(() => (copyStatus.textContent = ""), 2200);
});

const loaded = await actor.load();
if (loaded) {
  const boneNames = actor.getDebugBoneNames();
  for (const name of boneNames) boneSelect.add(new Option(name, name));
  const params = new URLSearchParams(location.search);
  const requestedState = params.get("state");
  const requestedBone = params.get("bone");
  if (requestedState && TAMA_STATES.includes(requestedState as TamaState)) state = requestedState as TamaState;
  if (requestedBone && boneNames.includes(requestedBone)) bone = requestedBone;
  selectState(state);
  selectBone(boneNames.includes(bone) ? bone : boneNames[0] ?? "");
  document.body.dataset.ready = "true";
}

Object.assign(window, { __tamaDebug: actor });
