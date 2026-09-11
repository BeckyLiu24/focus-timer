const STORAGE_KEY = "focus-timer-state-v1";
const SESSION_LENGTHS = {
  starter: 5 * 60,
  focus: 25 * 60,
  shortBreak: 5 * 60,
  longBreak: 15 * 60
};

const rewards = ["🌱", "🌿", "🌷", "🍄", "🌻", "🪴", "🌳", "🏡"];
const dayNames = ["日", "一", "二", "三", "四", "五", "六"];

const defaultState = {
  growth: 0,
  xp: 0,
  completedSessions: [],
  interruptions: [],
  unlocked: 0,
  focusStreak: 0,
  lastCompletionDate: null
};

let state = loadState();
let selectedFocusMinutes = 5;
let session = {
  type: "starter",
  status: "idle",
  remaining: SESSION_LENGTHS.starter,
  duration: SESSION_LENGTHS.starter,
  startedAt: null,
  task: ""
};
let timerId = null;
let completionContext = null;
let audioContext = null;
let noiseSource = null;
let noiseGain = null;
let soundEnabled = false;

const el = {
  notifyButton: document.getElementById("notify-button"),
  gardenBed: document.getElementById("garden-bed"),
  gardenStage: document.getElementById("garden-stage"),
  collectionCount: document.getElementById("collection-count"),
  taskInput: document.getElementById("task-input"),
  durationPicker: document.getElementById("duration-picker"),
  durationOptions: Array.from(document.querySelectorAll(".duration-option")),
  customMinutes: document.getElementById("custom-minutes"),
  soundToggle: document.getElementById("sound-toggle"),
  soundSelect: document.getElementById("sound-select"),
  volumeControl: document.getElementById("volume-control"),
  timeLeft: document.getElementById("time-left"),
  modeLabel: document.getElementById("mode-label"),
  primaryAction: document.getElementById("primary-action"),
  secondaryAction: document.getElementById("secondary-action"),
  sessionNote: document.getElementById("session-note"),
  todayCount: document.getElementById("today-count"),
  streakCount: document.getElementById("streak-count"),
  totalMinutes: document.getElementById("total-minutes"),
  growthCount: document.getElementById("growth-count"),
  autoCycle: document.getElementById("auto-cycle"),
  interruptionCount: document.getElementById("interruption-count"),
  weekChart: document.getElementById("week-chart"),
  collection: document.getElementById("collection"),
  xpCount: document.getElementById("xp-count"),
  rewardDialog: document.getElementById("reward-dialog"),
  rewardTitle: document.getElementById("reward-title"),
  rewardCopy: document.getElementById("reward-copy"),
  rewardPrize: document.getElementById("reward-prize"),
  extendFocus: document.getElementById("extend-focus")
};

el.primaryAction.addEventListener("click", handlePrimaryAction);
el.secondaryAction.addEventListener("click", handleSecondaryAction);
el.notifyButton.addEventListener("click", requestNotifications);
el.taskInput.addEventListener("input", updateSessionTask);
el.durationOptions.forEach((button) => button.addEventListener("click", selectPresetDuration));
el.customMinutes.addEventListener("input", selectCustomDuration);
el.autoCycle.addEventListener("change", renderActions);
el.soundToggle.addEventListener("click", toggleSound);
el.soundSelect.addEventListener("change", restartSoundIfNeeded);
el.volumeControl.addEventListener("input", updateVolume);
el.rewardDialog.addEventListener("close", handleRewardClose);
document.addEventListener("visibilitychange", syncTimer);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
}

render();

function handlePrimaryAction() {
  if (session.status === "idle") {
    startSession(session.type);
    return;
  }

  if (session.status === "running") {
    pauseSession();
    return;
  }

  if (session.status === "paused") {
    resumeSession();
  }
}

function handleSecondaryAction() {
  if (session.status === "running" || session.status === "paused") {
    interruptSession();
    return;
  }

  if (session.type === "shortBreak" || session.type === "longBreak") {
    resetToStarter("休息跳过了。想开始时，一键就好。");
  }
}

function startSession(type) {
  clearInterval(timerId);
  const duration = getDurationForType(type);
  session = {
    type,
    status: "running",
    remaining: duration,
    duration,
    startedAt: Date.now(),
    endsAt: Date.now() + duration * 1000,
    task: el.taskInput.value.trim()
  };
  timerId = setInterval(tick, 500);
  render();
}

function pauseSession() {
  syncTimer();
  clearInterval(timerId);
  session.status = "paused";
  session.endsAt = null;
  render();
}

function resumeSession() {
  session.status = "running";
  session.endsAt = Date.now() + session.remaining * 1000;
  timerId = setInterval(tick, 500);
  render();
}

function interruptSession() {
  clearInterval(timerId);
  state.interruptions.push({
    date: todayKey(),
    type: session.type,
    task: currentTask(),
    secondsLeft: session.remaining
  });
  saveState();
  resetToStarter("中断已温和记录。它不会抹掉你已经完成的部分。");
}

function tick() {
  syncTimer();
  if (session.remaining <= 0) {
    completeSession();
  }
}

function syncTimer() {
  if (session.status !== "running" || !session.endsAt) return;
  session.remaining = Math.max(0, Math.ceil((session.endsAt - Date.now()) / 1000));
  renderTimer();
}

function completeSession() {
  clearInterval(timerId);
  const completedType = session.type;
  const minutes = Math.round(session.duration / 60);

  if (completedType === "shortBreak" || completedType === "longBreak") {
    if (el.autoCycle.checked) {
      startSession("starter");
      notify("休息结束", `下一轮 ${selectedFocusMinutes} 分钟专注已开始。`);
      return;
    }

    resetToStarter(`休息结束。下一轮可以从 ${selectedFocusMinutes} 分钟重新开始。`);
    notify("休息结束", "准备好时，再开始一个很小的 5 分钟。");
    return;
  }

  const reward = calculateReward(completedType, minutes);

  state.growth += reward.growth;
  state.xp += reward.xp;
  state.completedSessions.push({
    date: todayKey(),
    type: completedType,
    task: currentTask(),
    minutes
  });
  updateStreak();
  state.unlocked = calculateUnlocked(state.xp);
  saveState();

  completionContext = { completedType, reward, minutes };
  session.status = "idle";
  session.remaining = selectedFocusMinutes * 60;
  session.duration = selectedFocusMinutes * 60;
  session.endsAt = null;
  notify("专注完成", `完成 ${minutes} 分钟，获得 ${reward.growth} 成长值。`);

  if (el.autoCycle.checked) {
    completionContext = null;
    const completedFocusCount = state.completedSessions.filter((item) => item.type === "focus" || item.type === "starter").length;
    const needsLongBreak = completedFocusCount > 0 && completedFocusCount % 4 === 0;
    startBreakSuggestion(needsLongBreak ? "longBreak" : "shortBreak");
    startSession(needsLongBreak ? "longBreak" : "shortBreak");
    el.sessionNote.textContent = `完成 ${minutes} 分钟，植物获得 +${reward.growth} 成长值。自动进入休息。`;
    return;
  }

  showReward(completedType, reward);
  render();
}

function showReward(type, reward) {
  const isStarter = type === "starter";
  el.rewardTitle.textContent = isStarter ? "启动成功" : "完整一轮完成";
  el.rewardCopy.textContent = isStarter
    ? "最难的是开始。你已经越过门槛了。"
    : "这一轮已经被稳稳收进记录。";
  el.rewardPrize.textContent = `+${reward.growth} 成长值 · +${reward.xp} XP`;
  el.extendFocus.hidden = !isStarter;
  if (typeof el.rewardDialog.showModal === "function") {
    el.rewardDialog.showModal();
  }
}

function getDurationForType(type) {
  if (type === "starter") return selectedFocusMinutes * 60;
  return SESSION_LENGTHS[type];
}

function calculateReward(type, minutes) {
  if (type === "starter") {
    return {
      growth: Math.max(1, minutes),
      xp: Math.max(2, minutes * 2)
    };
  }

  return {
    growth: Math.max(5, minutes),
    xp: Math.max(10, Math.round(minutes * 1.8))
  };
}

function updateSessionTask() {
  if (session.status === "running" || session.status === "paused") {
    session.task = currentTask();
    renderActions();
  }
}

function selectPresetDuration(event) {
  selectedFocusMinutes = Number(event.currentTarget.dataset.minutes);
  el.customMinutes.value = "";
  applySelectedDuration();
}

function selectCustomDuration() {
  const minutes = clampMinutes(Number(el.customMinutes.value));
  if (!minutes) return;
  selectedFocusMinutes = minutes;
  applySelectedDuration();
}

function applySelectedDuration() {
  if (session.status !== "idle" || session.type !== "starter") return;
  session.remaining = selectedFocusMinutes * 60;
  session.duration = selectedFocusMinutes * 60;
  render();
}

function currentTask() {
  return el.taskInput.value.trim();
}

function clampMinutes(value) {
  if (!Number.isFinite(value)) return null;
  return Math.min(120, Math.max(1, Math.round(value)));
}

function handleRewardClose() {
  if (!completionContext) return;
  const shouldExtend = el.rewardDialog.returnValue === "extend" && completionContext.completedType === "starter";
  completionContext = null;

  if (shouldExtend) {
    startSession("focus");
  } else {
    const completedFocusCount = state.completedSessions.filter((item) => item.type === "focus").length;
    const needsLongBreak = completedFocusCount > 0 && completedFocusCount % 4 === 0;
    startBreakSuggestion(needsLongBreak ? "longBreak" : "shortBreak");
  }
}

function startBreakSuggestion(type) {
  session = {
    type,
    status: "idle",
    remaining: SESSION_LENGTHS[type],
    duration: SESSION_LENGTHS[type],
    startedAt: null,
    task: ""
  };
  el.taskInput.value = "";
  render();
}

function resetToStarter(note) {
  clearInterval(timerId);
  session = {
    type: "starter",
    status: "idle",
    remaining: selectedFocusMinutes * 60,
    duration: selectedFocusMinutes * 60,
    startedAt: null,
    task: ""
  };
  render();
  el.sessionNote.textContent = note;
}

function updateStreak() {
  const today = todayKey();
  if (state.lastCompletionDate === today) return;

  const yesterday = dateKey(addDays(new Date(), -1));
  state.focusStreak = state.lastCompletionDate === yesterday ? state.focusStreak + 1 : 1;
  state.lastCompletionDate = today;
}

function render() {
  renderTimer();
  renderActions();
  renderStats();
  renderGarden();
  renderSound();
}

function renderTimer() {
  el.timeLeft.textContent = formatTime(session.remaining);
  el.modeLabel.textContent = modeText(session.type);
}

function renderActions() {
  renderDurationPicker();
  if (session.status === "running") {
    el.primaryAction.textContent = "暂停";
    el.secondaryAction.textContent = "中断本轮";
    el.secondaryAction.hidden = false;
    el.taskInput.disabled = false;
    el.sessionNote.textContent = currentTask() ? `正在做：${currentTask()}` : "正在专注。手机可以放到一边了。";
    return;
  }

  if (session.status === "paused") {
    el.primaryAction.textContent = "继续";
    el.secondaryAction.textContent = "中断本轮";
    el.secondaryAction.hidden = false;
    el.taskInput.disabled = false;
    el.sessionNote.textContent = "暂停中。回来继续也算数。";
    return;
  }

  el.taskInput.disabled = false;
  if (session.type === "shortBreak" || session.type === "longBreak") {
    el.primaryAction.textContent = session.type === "longBreak" ? "开始 15 分钟休息" : "开始 5 分钟休息";
    el.secondaryAction.textContent = "跳过休息";
    el.secondaryAction.hidden = false;
    el.sessionNote.textContent = session.type === "longBreak"
      ? "已经完成 4 个完整专注轮，建议长休息。"
      : "建议休息 5 分钟，也可以跳过。";
    return;
  }

  el.primaryAction.textContent = `开始 ${selectedFocusMinutes} 分钟`;
  el.secondaryAction.hidden = true;
  el.sessionNote.textContent = focusIdleNote();
}

function renderDurationPicker() {
  const isFocusIdle = session.status === "idle" && session.type === "starter";
  el.durationPicker.classList.toggle("disabled", !isFocusIdle);
  el.durationOptions.forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.minutes) === selectedFocusMinutes);
  });
}

async function toggleSound() {
  if (soundEnabled) {
    stopSound();
    renderSound();
    return;
  }

  try {
    await startSound();
    el.sessionNote.textContent = "背景声音已开启。它只在这个页面里播放。";
  } catch {
    el.sessionNote.textContent = "这个浏览器暂时不允许播放声音，请再点一次声音按钮。";
  }
  renderSound();
}

async function startSound() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();
    noiseGain = audioContext.createGain();
    noiseGain.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  stopNoiseSource();
  noiseSource = audioContext.createBufferSource();
  noiseSource.buffer = createNoiseBuffer(el.soundSelect.value);
  noiseSource.loop = true;
  noiseSource.connect(noiseGain);
  updateVolume();
  noiseSource.start();
  soundEnabled = true;
}

function stopSound() {
  stopNoiseSource();
  soundEnabled = false;
}

function stopNoiseSource() {
  if (!noiseSource) return;
  try {
    noiseSource.stop();
  } catch {
    // Already stopped.
  }
  noiseSource.disconnect();
  noiseSource = null;
}

function restartSoundIfNeeded() {
  if (soundEnabled) {
    startSound();
  }
}

function updateVolume() {
  if (!noiseGain) return;
  const volume = Number(el.volumeControl.value) / 100;
  noiseGain.gain.setTargetAtTime(volume * volume * 0.42, audioContext.currentTime, 0.03);
}

function renderSound() {
  el.soundToggle.classList.toggle("active", soundEnabled);
  el.soundToggle.setAttribute("aria-pressed", String(soundEnabled));
  el.soundToggle.firstElementChild.textContent = soundEnabled ? "🔊" : "🔇";
  el.soundToggle.lastElementChild.textContent = soundEnabled ? "声音开启" : "声音关闭";
}

function createNoiseBuffer(type) {
  const sampleRate = audioContext.sampleRate;
  const frameCount = sampleRate * 2;
  const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
  const data = buffer.getChannelData(0);

  if (type === "rain") {
    fillRainNoise(data);
    return buffer;
  }

  let lastOut = 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;

  for (let index = 0; index < frameCount; index += 1) {
    const white = Math.random() * 2 - 1;

    if (type === "brown") {
      lastOut = (lastOut + 0.02 * white) / 1.02;
      data[index] = lastOut * 3.5;
    } else if (type === "pink") {
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[index] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    } else {
      data[index] = white * 0.45;
    }
  }

  return buffer;
}

function fillRainNoise(data) {
  let drip = 0;
  for (let index = 0; index < data.length; index += 1) {
    const base = (Math.random() * 2 - 1) * 0.15;
    if (Math.random() > 0.985) drip = Math.random() * 0.8;
    drip *= 0.92;
    data[index] = base + drip * (Math.random() * 2 - 1);
  }
}

function focusIdleNote() {
  const cycleText = el.autoCycle.checked
    ? "结束后会自动进入 5 分钟休息，再开始下一轮。"
    : "结束后会建议休息，不会自动开始下一轮。";
  if (selectedFocusMinutes === 5) {
    return `先开始 5 分钟。完成后可以继续 25 分钟，也可以收下奖励。${cycleText}`;
  }
  return `这轮是 ${selectedFocusMinutes} 分钟专注。${cycleText}`;
}

function renderStats() {
  const today = todayKey();
  const todaySessions = state.completedSessions.filter((item) => item.date === today);
  const totalMinutes = state.completedSessions.reduce((sum, item) => sum + item.minutes, 0);
  const todayInterruptions = state.interruptions.filter((item) => item.date === today).length;

  el.todayCount.textContent = todaySessions.length;
  el.streakCount.textContent = state.focusStreak;
  el.totalMinutes.textContent = totalMinutes;
  el.growthCount.textContent = state.growth;
  el.xpCount.textContent = `${state.xp} XP`;
  el.interruptionCount.textContent = `${todayInterruptions} 次中断`;

  renderWeekChart();
  renderCollection();
}

function renderWeekChart() {
  const days = Array.from({ length: 7 }, (_, index) => addDays(new Date(), index - 6));
  const totals = days.map((day) => {
    const key = dateKey(day);
    return state.completedSessions
      .filter((item) => item.date === key)
      .reduce((sum, item) => sum + item.minutes, 0);
  });
  const max = Math.max(25, ...totals);

  el.weekChart.innerHTML = days.map((day, index) => {
    const minutes = totals[index];
    const height = Math.max(4, Math.round((minutes / max) * 96));
    return `
      <div class="day-bar" aria-label="${dateKey(day)} ${minutes} 分钟">
        <div class="bar-track"><div class="bar-fill" style="height:${height}px"></div></div>
        <span>${dayNames[day.getDay()]}</span>
      </div>
    `;
  }).join("");
}

function renderGarden() {
  const unlocked = Math.max(1, state.unlocked);
  el.gardenBed.innerHTML = rewards.map((item, index) => `
    <div class="plant ${index < unlocked ? "" : "locked"}" aria-hidden="true"><span>${item}</span></div>
  `).join("");
  el.gardenStage.textContent = state.unlocked === 0 ? "种下一颗开始的种子" : "小花园正在长大";
  el.collectionCount.textContent = `${state.unlocked}/${rewards.length}`;
}

function renderCollection() {
  el.collection.innerHTML = rewards.map((item, index) => `
    <div class="collectible ${index < state.unlocked ? "" : "locked"}" aria-label="${index < state.unlocked ? "已解锁" : "未解锁"}">${index < state.unlocked ? item : "?"}</div>
  `).join("");
}

function requestNotifications() {
  if (!("Notification" in window)) {
    el.sessionNote.textContent = "这个浏览器不支持通知，但计时和记录都能正常用。";
    return;
  }

  Notification.requestPermission().then((permission) => {
    el.sessionNote.textContent = permission === "granted"
      ? "通知已开启。完成时会轻轻提醒你。"
      : "通知没有开启，也没关系，页面内提醒仍然可用。";
  });
}

function calculateUnlocked(xp) {
  if (xp < 10) return 0;
  return Math.min(rewards.length, 1 + Math.floor((xp - 10) / 40));
}

function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  new Notification(title, { body, icon: "icons/icon-192.svg" });
}

function modeText(type) {
  return {
    starter: "启动专注",
    focus: "完整专注",
    shortBreak: "短休息",
    longBreak: "长休息"
  }[type];
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function todayKey() {
  return dateKey(new Date());
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, offset) {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
}

function loadState() {
  try {
    const saved = { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
    saved.growth = Number.isFinite(saved.growth) ? saved.growth : (saved.coins || 0);
    saved.unlocked = calculateUnlocked(saved.xp);
    return saved;
  } catch {
    return { ...defaultState };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
