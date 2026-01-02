const ui = {
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status"),
  note: document.getElementById("note"),
  frequency: document.getElementById("frequency"),
  velocity: document.getElementById("velocity-display"),
  clarity: document.getElementById("clarity"),
  midiOutput: document.getElementById("midi-output"),
  log: document.getElementById("log"),
  inputGain: document.getElementById("input-gain"),
  inputGainValue: document.getElementById("input-gain-value"),
  highpass: document.getElementById("highpass"),
  highpassValue: document.getElementById("highpass-value"),
  lowpass: document.getElementById("lowpass"),
  lowpassValue: document.getElementById("lowpass-value"),
  noiseGate: document.getElementById("noise-gate"),
  noiseGateValue: document.getElementById("noise-gate-value"),
  smoothing: document.getElementById("smoothing"),
  smoothingValue: document.getElementById("smoothing-value"),
  stability: document.getElementById("stability"),
  stabilityValue: document.getElementById("stability-value"),
  minDuration: document.getElementById("min-duration"),
  minDurationValue: document.getElementById("min-duration-value"),
  bendRange: document.getElementById("bend-range"),
  bendRangeValue: document.getElementById("bend-range-value"),
  pitchBendEnabled: document.getElementById("pitch-bend-enabled"),
  noteHysteresis: document.getElementById("note-hysteresis"),
  noteHysteresisValue: document.getElementById("note-hysteresis-value"),
  minFrequency: document.getElementById("min-frequency"),
  minFrequencyValue: document.getElementById("min-frequency-value"),
  maxFrequency: document.getElementById("max-frequency"),
  maxFrequencyValue: document.getElementById("max-frequency-value"),
  clarityThreshold: document.getElementById("clarity-threshold"),
  clarityThresholdValue: document.getElementById("clarity-threshold-value"),
  attackThreshold: document.getElementById("attack-threshold"),
  attackThresholdValue: document.getElementById("attack-threshold-value"),
  velocitySensitivity: document.getElementById("velocity"),
  velocitySensitivityValue: document.getElementById("velocity-value"),
  analysisInterval: document.getElementById("analysis-interval"),
  analysisIntervalValue: document.getElementById("analysis-interval-value"),
  monitorEnabled: document.getElementById("monitor-enabled"),
  monitorVolume: document.getElementById("monitor-volume"),
  monitorVolumeValue: document.getElementById("monitor-volume-value"),
};

let audioContext;
let analyser;
let mediaStream;
let isRunning = false;
let midiAccess;
let midiOutput;
let analysisTimer;
let gainNode;
let highpassFilter;
let lowpassFilter;

let currentNote = null;
let lastStableNote = null;
let stableCount = 0;
let lastNoteOnTime = 0;
let lastNoteOffTime = 0;
let lastFrequency = 0;
let lastClarity = 0;
let lastRmsDb = -120;
let monitorContext;
let monitorGain;
let monitorOscillator;
let monitorNote = null;
let lastMonitorUpdate = 0;

const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const log = (message) => {
  const timestamp = new Date().toLocaleTimeString();
  ui.log.value = `[${timestamp}] ${message}\n` + ui.log.value;
};

const updateValue = (input, output, suffix = "") => {
  output.textContent = `${input.value}${suffix}`;
};

const initControlBindings = () => {
  const bindings = [
    [ui.inputGain, ui.inputGainValue, " dB"],
    [ui.highpass, ui.highpassValue, " Hz"],
    [ui.lowpass, ui.lowpassValue, " Hz"],
    [ui.noiseGate, ui.noiseGateValue, " dB"],
    [ui.smoothing, ui.smoothingValue, ""],
    [ui.stability, ui.stabilityValue, ""],
    [ui.minDuration, ui.minDurationValue, " ms"],
    [ui.bendRange, ui.bendRangeValue, ""],
    [ui.noteHysteresis, ui.noteHysteresisValue, ""],
    [ui.minFrequency, ui.minFrequencyValue, " Hz"],
    [ui.maxFrequency, ui.maxFrequencyValue, " Hz"],
    [ui.clarityThreshold, ui.clarityThresholdValue, ""],
    [ui.attackThreshold, ui.attackThresholdValue, " dB"],
    [ui.velocitySensitivity, ui.velocitySensitivityValue, ""],
    [ui.analysisInterval, ui.analysisIntervalValue, " ms"],
    [ui.monitorVolume, ui.monitorVolumeValue, ""],
  ];

  bindings.forEach(([input, output, suffix]) => {
    updateValue(input, output, suffix);
    input.addEventListener("input", () => updateValue(input, output, suffix));
  });
};

const dbFromRms = (rms) => 20 * Math.log10(rms || 1e-6);

const autoCorrelate = (buffer, sampleRate) => {
  const size = buffer.length;
  let rms = 0;
  for (let i = 0; i < size; i += 1) {
    const value = buffer[i];
    rms += value * value;
  }
  rms = Math.sqrt(rms / size);

  if (dbFromRms(rms) < Number(ui.noiseGate.value)) {
    return { frequency: null, rms };
  }

  const minFrequency = Number(ui.minFrequency.value);
  const maxFrequency = Number(ui.maxFrequency.value);
  const minLag = Math.floor(sampleRate / maxFrequency);
  const maxLag = Math.min(size - 1, Math.floor(sampleRate / minFrequency));
  const correlation = new Array(maxLag + 1).fill(0);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < size - lag; i += 1) {
      sum += buffer[i] * buffer[i + lag];
    }
    correlation[lag] = sum;
  }

  let dip = minLag;
  while (dip < maxLag - 1 && correlation[dip] > correlation[dip + 1]) {
    dip += 1;
  }

  let peak = -1;
  let peakIndex = -1;
  for (let i = dip; i <= maxLag; i += 1) {
    if (correlation[i] > peak) {
      peak = correlation[i];
      peakIndex = i;
    }
  }

  if (peakIndex <= 0) {
    return { frequency: null, rms };
  }

  const r0 = correlation[0] || 1;
  const clarity = peak / r0;
  let refinedIndex = peakIndex;
  if (peakIndex > 1 && peakIndex < maxLag) {
    const y1 = correlation[peakIndex - 1];
    const y2 = correlation[peakIndex];
    const y3 = correlation[peakIndex + 1];
    const denom = y1 - 2 * y2 + y3;
    if (Math.abs(denom) > 1e-6) {
      const delta = 0.5 * (y1 - y3) / denom;
      refinedIndex = peakIndex + delta;
    }
  }
  const frequency = sampleRate / refinedIndex;
  return { frequency, rms, clarity };
};

const frequencyToMidi = (frequency) => 69 + 12 * Math.log2(frequency / 440);

const midiToNoteName = (midi) => {
  const rounded = Math.round(midi);
  const name = noteNames[rounded % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
};

const sendMidi = (data) => {
  if (midiOutput) {
    midiOutput.send(data);
  } else {
    log(`MIDI ${data.join(", ")}`);
  }
};

const sendNoteOn = (note, velocity) => {
  sendMidi([0x90, note, velocity]);
};

const sendNoteOff = (note) => {
  sendMidi([0x80, note, 0]);
};

const sendPitchBend = (value) => {
  const clamped = Math.max(-8192, Math.min(8191, value));
  const lsb = (clamped + 8192) & 0x7f;
  const msb = ((clamped + 8192) >> 7) & 0x7f;
  sendMidi([0xe0, lsb, msb]);
};

const ensureMonitorContext = () => {
  if (!monitorContext) {
    monitorContext = new (window.AudioContext || window.webkitAudioContext)();
    monitorGain = monitorContext.createGain();
    monitorGain.gain.value = Number(ui.monitorVolume.value);
    monitorGain.connect(monitorContext.destination);
  }
};

const setMonitorActive = (active, note, velocity) => {
  if (!ui.monitorEnabled.checked) {
    return;
  }

  ensureMonitorContext();

  if (active) {
    const now = monitorContext.currentTime;
    const frequency = 440 * 2 ** ((note - 69) / 12);
    if (!monitorOscillator) {
      monitorOscillator = monitorContext.createOscillator();
      monitorOscillator.type = "sine";
      monitorOscillator.connect(monitorGain);
      monitorOscillator.start();
    }
    if (monitorNote !== note) {
      monitorOscillator.frequency.setTargetAtTime(frequency, now, 0.01);
      monitorNote = note;
    }
    const targetGain = Math.max(0.05, Math.min(0.8, velocity / 127));
    monitorGain.gain.setTargetAtTime(targetGain, now, 0.02);
  } else if (monitorGain) {
    monitorGain.gain.setTargetAtTime(0, monitorContext.currentTime, 0.03);
    monitorNote = null;
  }
};

const updateMonitorPitch = (note) => {
  if (!monitorOscillator || monitorNote === null) {
    return;
  }
  const now = monitorContext.currentTime;
  const frequency = 440 * 2 ** ((note - 69) / 12);
  monitorOscillator.frequency.setTargetAtTime(frequency, now, 0.01);
  monitorNote = note;
};

const updateMidiOutputList = () => {
  ui.midiOutput.innerHTML = '<option value="">Sin dispositivo</option>';
  if (!midiAccess) {
    return;
  }

  for (const output of midiAccess.outputs.values()) {
    const option = document.createElement("option");
    option.value = output.id;
    option.textContent = output.name;
    ui.midiOutput.appendChild(option);
  }
};

const handlePitch = (frequency, rms, clarity, onset) => {
  if (!frequency) {
    if (currentNote !== null) {
      const now = performance.now();
      if (now - lastNoteOnTime > Number(ui.minDuration.value)) {
        sendNoteOff(currentNote);
        sendPitchBend(0);
        log(`Note Off ${midiToNoteName(currentNote)}`);
        setMonitorActive(false);
        currentNote = null;
        lastStableNote = null;
        stableCount = 0;
        lastNoteOffTime = now;
      }
    }
    ui.note.textContent = "--";
    ui.frequency.textContent = "-- Hz";
    ui.velocity.textContent = "--";
    ui.clarity.textContent = "--";
    return;
  }

  const midiValue = frequencyToMidi(frequency);
  const note = Math.round(midiValue);
  const centsDiff = Math.abs((midiValue - note) * 100);
  const velocity = Math.min(127, Math.max(20, Math.round(rms * 127 * Number(ui.velocitySensitivity.value))));

  ui.note.textContent = midiToNoteName(note);
  ui.frequency.textContent = `${frequency.toFixed(1)} Hz`;
  ui.velocity.textContent = velocity;
  ui.clarity.textContent = clarity.toFixed(2);

  if (clarity < Number(ui.clarityThreshold.value)) {
    stableCount = 0;
    if (currentNote !== null) {
      const now = performance.now();
      if (now - lastNoteOnTime > Number(ui.minDuration.value)) {
        sendNoteOff(currentNote);
        sendPitchBend(0);
        log(`Note Off ${midiToNoteName(currentNote)}`);
        setMonitorActive(false);
        currentNote = null;
        lastStableNote = null;
        lastNoteOffTime = now;
      }
    }
    return;
  }

  if (onset && (currentNote === null || note !== currentNote)) {
    lastStableNote = note;
    stableCount = Number(ui.stability.value);
  }

  if (lastStableNote === note) {
    stableCount += 1;
  } else if (centsDiff <= Number(ui.noteHysteresis.value)) {
    lastStableNote = note;
    stableCount = 1;
  } else {
    stableCount = 0;
  }

  if (stableCount >= Number(ui.stability.value)) {
    const now = performance.now();
    const minRepeatInterval = Math.max(40, Number(ui.minDuration.value) * 0.5);
    const canRetriggerSameNote =
      onset &&
      currentNote === note &&
      now - lastNoteOnTime >= minRepeatInterval &&
      now - lastNoteOffTime >= minRepeatInterval;
    if (currentNote !== note || canRetriggerSameNote) {
      if (currentNote !== null) {
        const duration = now - lastNoteOnTime;
        if (!onset && duration < Number(ui.minDuration.value)) {
          return;
        }
        sendNoteOff(currentNote);
        log(`Note Off ${midiToNoteName(currentNote)}`);
        lastNoteOffTime = now;
      }
      currentNote = note;
      lastNoteOnTime = now;
      sendNoteOn(note, velocity);
      if (!ui.pitchBendEnabled.checked) {
        sendPitchBend(0);
      }
      log(`Note On ${midiToNoteName(note)} vel ${velocity}`);
      setMonitorActive(true, note, velocity);
    }
  }

  if (currentNote !== null && ui.pitchBendEnabled.checked) {
    const bendRange = Number(ui.bendRange.value);
    const bendValue = Math.round(((midiValue - currentNote) / bendRange) * 8192);
    sendPitchBend(bendValue);
  } else if (currentNote !== null && !ui.pitchBendEnabled.checked) {
    sendPitchBend(0);
  }
};

const analyze = () => {
  if (!analyser) {
    return;
  }
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);
  const { frequency, rms, clarity } = autoCorrelate(buffer, audioContext.sampleRate);
  const rmsDb = dbFromRms(rms);
  const deltaDb = rmsDb - lastRmsDb;
  lastRmsDb = rmsDb;
  const onset = deltaDb > Number(ui.attackThreshold.value);
  const smoothing = Number(ui.smoothing.value);
  let effectiveSmoothing = smoothing;
  if (frequency && lastFrequency) {
    const diffCents = Math.abs(1200 * Math.log2(frequency / lastFrequency));
    if (diffCents > 80) {
      effectiveSmoothing = Math.min(effectiveSmoothing, 0.15);
    }
  }
  if (onset) {
    effectiveSmoothing = Math.min(effectiveSmoothing, 0.15);
  }
  if (frequency && lastFrequency) {
    lastFrequency = effectiveSmoothing * lastFrequency + (1 - effectiveSmoothing) * frequency;
  } else if (frequency) {
    lastFrequency = frequency;
  } else {
    lastFrequency = 0;
  }

  lastClarity = effectiveSmoothing * lastClarity + (1 - effectiveSmoothing) * (clarity || 0);
  handlePitch(lastFrequency || null, rms, lastClarity, onset);

  if (currentNote !== null && performance.now() - lastMonitorUpdate > 60) {
    updateMonitorPitch(currentNote);
    lastMonitorUpdate = performance.now();
  }
};

const startAnalysis = () => {
  const interval = Number(ui.analysisInterval.value);
  analysisTimer = setInterval(analyze, interval);
};

const stopAnalysis = () => {
  clearInterval(analysisTimer);
  analysisTimer = null;
};

const start = async () => {
  if (isRunning) {
    return;
  }
  isRunning = true;
  ui.start.disabled = true;
  ui.stop.disabled = false;
  ui.status.textContent = "Iniciando...";

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    gainNode = audioContext.createGain();
    highpassFilter = audioContext.createBiquadFilter();
    lowpassFilter = audioContext.createBiquadFilter();
    analyser = audioContext.createAnalyser();

    gainNode.gain.value = 10 ** (Number(ui.inputGain.value) / 20);
    highpassFilter.type = "highpass";
    highpassFilter.frequency.value = Number(ui.highpass.value);
    highpassFilter.Q.value = 0.8;
    lowpassFilter.type = "lowpass";
    lowpassFilter.frequency.value = Number(ui.lowpass.value);
    lowpassFilter.Q.value = 0.8;
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;

    source.connect(gainNode);
    gainNode.connect(highpassFilter);
    highpassFilter.connect(lowpassFilter);
    lowpassFilter.connect(analyser);

    if (navigator.requestMIDIAccess) {
      midiAccess = await navigator.requestMIDIAccess();
      midiAccess.onstatechange = updateMidiOutputList;
      updateMidiOutputList();
    } else {
      log("Web MIDI no disponible en este navegador.");
    }

    ui.status.textContent = "Analizando";
    log("Conversión iniciada.");
    startAnalysis();
  } catch (error) {
    console.error(error);
    log("No se pudo iniciar la captura de audio.");
    ui.status.textContent = "Error";
    stop();
  }
};

const stop = () => {
  isRunning = false;
  ui.start.disabled = false;
  ui.stop.disabled = true;
  ui.status.textContent = "Detenido";
  stopAnalysis();

  if (currentNote !== null) {
    sendNoteOff(currentNote);
    sendPitchBend(0);
    currentNote = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  analyser = null;
  gainNode = null;
  highpassFilter = null;
  lowpassFilter = null;
  lastFrequency = 0;
  lastClarity = 0;
  stableCount = 0;
  lastStableNote = null;
  lastRmsDb = -120;
  lastNoteOffTime = 0;
  log("Conversión detenida.");
};

ui.start.addEventListener("click", start);
ui.stop.addEventListener("click", stop);
ui.midiOutput.addEventListener("change", (event) => {
  const id = event.target.value;
  midiOutput = id && midiAccess ? midiAccess.outputs.get(id) : null;
  if (midiOutput) {
    log(`Salida MIDI seleccionada: ${midiOutput.name}`);
  }
});

ui.inputGain.addEventListener("input", () => {
  if (gainNode) {
    gainNode.gain.value = 10 ** (Number(ui.inputGain.value) / 20);
  }
});

ui.highpass.addEventListener("input", () => {
  if (highpassFilter) {
    highpassFilter.frequency.value = Number(ui.highpass.value);
  }
});

ui.lowpass.addEventListener("input", () => {
  if (lowpassFilter) {
    lowpassFilter.frequency.value = Number(ui.lowpass.value);
  }
});

ui.monitorVolume.addEventListener("input", () => {
  if (monitorGain) {
    monitorGain.gain.value = Number(ui.monitorVolume.value);
  }
});

ui.monitorEnabled.addEventListener("change", () => {
  if (!ui.monitorEnabled.checked) {
    setMonitorActive(false);
  }
});

initControlBindings();
