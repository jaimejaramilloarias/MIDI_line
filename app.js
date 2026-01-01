const ui = {
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  status: document.getElementById("status"),
  note: document.getElementById("note"),
  frequency: document.getElementById("frequency"),
  velocity: document.getElementById("velocity"),
  midiOutput: document.getElementById("midi-output"),
  log: document.getElementById("log"),
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
  noteHysteresis: document.getElementById("note-hysteresis"),
  noteHysteresisValue: document.getElementById("note-hysteresis-value"),
  velocitySensitivity: document.getElementById("velocity"),
  velocitySensitivityValue: document.getElementById("velocity-value"),
  analysisInterval: document.getElementById("analysis-interval"),
  analysisIntervalValue: document.getElementById("analysis-interval-value"),
};

let audioContext;
let analyser;
let mediaStream;
let isRunning = false;
let midiAccess;
let midiOutput;
let analysisTimer;

let currentNote = null;
let lastStableNote = null;
let stableCount = 0;
let lastNoteOnTime = 0;
let lastFrequency = 0;

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
    [ui.noiseGate, ui.noiseGateValue, " dB"],
    [ui.smoothing, ui.smoothingValue, ""],
    [ui.stability, ui.stabilityValue, ""],
    [ui.minDuration, ui.minDurationValue, " ms"],
    [ui.bendRange, ui.bendRangeValue, ""],
    [ui.noteHysteresis, ui.noteHysteresisValue, ""],
    [ui.velocitySensitivity, ui.velocitySensitivityValue, ""],
    [ui.analysisInterval, ui.analysisIntervalValue, " ms"],
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

  const correlation = new Array(size).fill(0);
  for (let lag = 0; lag < size; lag += 1) {
    let sum = 0;
    for (let i = 0; i < size - lag; i += 1) {
      sum += buffer[i] * buffer[i + lag];
    }
    correlation[lag] = sum;
  }

  let dip = 0;
  while (dip < size - 1 && correlation[dip] > correlation[dip + 1]) {
    dip += 1;
  }

  let peak = -1;
  let peakIndex = -1;
  for (let i = dip; i < size; i += 1) {
    if (correlation[i] > peak) {
      peak = correlation[i];
      peakIndex = i;
    }
  }

  if (peakIndex <= 0) {
    return { frequency: null, rms };
  }

  const frequency = sampleRate / peakIndex;
  return { frequency, rms };
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

const handlePitch = (frequency, rms) => {
  if (!frequency) {
    if (currentNote !== null) {
      const now = performance.now();
      if (now - lastNoteOnTime > Number(ui.minDuration.value)) {
        sendNoteOff(currentNote);
        log(`Note Off ${midiToNoteName(currentNote)}`);
        currentNote = null;
        lastStableNote = null;
        stableCount = 0;
      }
    }
    ui.note.textContent = "--";
    ui.frequency.textContent = "-- Hz";
    ui.velocity.textContent = "--";
    return;
  }

  const midiValue = frequencyToMidi(frequency);
  const note = Math.round(midiValue);
  const centsDiff = Math.abs((midiValue - note) * 100);
  const velocity = Math.min(127, Math.max(20, Math.round(rms * 127 * Number(ui.velocitySensitivity.value))));

  ui.note.textContent = midiToNoteName(note);
  ui.frequency.textContent = `${frequency.toFixed(1)} Hz`;
  ui.velocity.textContent = velocity;

  if (lastStableNote === note) {
    stableCount += 1;
  } else if (centsDiff <= Number(ui.noteHysteresis.value)) {
    lastStableNote = note;
    stableCount = 1;
  } else {
    stableCount = 0;
  }

  if (stableCount >= Number(ui.stability.value)) {
    if (currentNote !== note) {
      if (currentNote !== null) {
        sendNoteOff(currentNote);
        log(`Note Off ${midiToNoteName(currentNote)}`);
      }
      currentNote = note;
      lastNoteOnTime = performance.now();
      sendNoteOn(note, velocity);
      log(`Note On ${midiToNoteName(note)} vel ${velocity}`);
    }
  }

  if (currentNote !== null) {
    const bendRange = Number(ui.bendRange.value);
    const bendValue = Math.round(((midiValue - currentNote) / bendRange) * 8192);
    sendPitchBend(bendValue);
  }
};

const analyze = () => {
  if (!analyser) {
    return;
  }
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);
  const { frequency, rms } = autoCorrelate(buffer, audioContext.sampleRate);
  const smoothing = Number(ui.smoothing.value);
  if (frequency && lastFrequency) {
    lastFrequency = smoothing * lastFrequency + (1 - smoothing) * frequency;
  } else if (frequency) {
    lastFrequency = frequency;
  } else {
    lastFrequency = 0;
  }

  handlePitch(lastFrequency || null, rms);
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
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

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
  lastFrequency = 0;
  stableCount = 0;
  lastStableNote = null;
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

initControlBindings();
