/* Gesture-gated procedural ambience. All short-lived Web Audio nodes are released on completion. */
'use strict';
(() => {
  class ForestAudio {
    constructor(getSettings, isAllowed) {
      this.getSettings = getSettings;
      this.isAllowed = isAllowed;
      this.ctx = null;
      this.master = null;
      this.ambient = null;
      this.voices = new Set();
      this.ambientLevel = -1;
      this.suspendTimer = 0;
      this.persistentNodes = [];
    }

    init() {
      if (!this.isAllowed() || !this.getSettings().audio || document.hidden) return;
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return;
      }
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      try {
        const ctx = this.ctx = new AudioContext();
        this.master = ctx.createGain(); this.master.gain.value = .58; this.master.connect(ctx.destination);
        const buffer = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate), data = buffer.getChannelData(0);
        let b = 0;
        for (let i = 0; i < data.length; i++) { b = (b + (Math.random() * 2 - 1) * .025) / 1.025; data[i] = b * 4; }
        this.noiseBuffer = buffer;
        const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter();
        source.buffer = buffer; source.loop = true; filter.type = 'lowpass'; filter.frequency.value = 420;
        this.ambient = ctx.createGain(); this.ambient.gain.value = .16; this.ambientLevel = .16;
        source.connect(filter).connect(this.ambient).connect(this.master); source.start();
        const drone = ctx.createOscillator(), droneGain = ctx.createGain();
        drone.frequency.value = 47; droneGain.gain.value = .022; drone.connect(droneGain).connect(this.master); drone.start();
        this.persistentNodes.push(source, filter, drone, droneGain, this.ambient, this.master);
      } catch (_) { this.dispose(); }
    }

    setEnabled(value) {
      this.getSettings().audio = value;
      clearTimeout(this.suspendTimer);
      if (value) this.init();
      if (!this.ctx || !this.master) return;
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(value ? .58 : 0, now, .08);
      if (!value) {
        this.stopEffects();
        this.suspendTimer = setTimeout(() => { if (!this.getSettings().audio && this.ctx) this.ctx.suspend().catch(() => {}); }, 300);
      }
    }

    setAmbient(value) {
      if (!this.ctx || !this.ambient || value === this.ambientLevel) return;
      this.ambientLevel = value;
      const now = this.ctx.currentTime;
      this.ambient.gain.cancelScheduledValues(now);
      this.ambient.gain.setTargetAtTime(value, now, .3);
    }

    canPlay() {
      return this.isAllowed() && this.getSettings().audio && !document.hidden && this.ctx?.state === 'running' && this.voices.size < 24;
    }

    track(source, nodes) {
      const voice = { source, nodes, released: false };
      const release = () => {
        if (voice.released) return;
        voice.released = true;
        source.onended = null;
        for (const node of nodes) { try { node.disconnect(); } catch (_) {} }
        this.voices.delete(voice);
      };
      voice.release = release; source.onended = release; this.voices.add(voice);
    }

    tone(freq, duration, volume = .1, type = 'sine', endFreq = freq, pan = 0) {
      if (!this.canPlay()) return;
      const ctx = this.ctx, osc = ctx.createOscillator(), gain = ctx.createGain(), now = ctx.currentTime;
      const nodes = [osc, gain];
      osc.type = type; osc.frequency.setValueAtTime(freq, now); osc.frequency.exponentialRampToValueAtTime(Math.max(10, endFreq), now + duration);
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(volume, now + .015); gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
      osc.connect(gain);
      if (ctx.createStereoPanner) {
        const panner = ctx.createStereoPanner(); panner.pan.value = Math.max(-1, Math.min(1, pan));
        gain.connect(panner).connect(this.master); nodes.push(panner);
      } else gain.connect(this.master);
      this.track(osc, nodes); osc.start(now); osc.stop(now + duration + .03);
    }

    noise(duration, volume, frequency = 700) {
      if (!this.canPlay()) return;
      const ctx = this.ctx, source = ctx.createBufferSource(), gain = ctx.createGain(), filter = ctx.createBiquadFilter(), now = ctx.currentTime;
      source.buffer = this.noiseBuffer; filter.type = 'lowpass'; filter.frequency.value = frequency;
      gain.gain.setValueAtTime(volume, now); gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
      source.connect(filter).connect(gain).connect(this.master);
      this.track(source, [source, filter, gain]); source.start(now, Math.random()); source.stop(now + duration);
    }

    stopEffects() {
      for (const voice of this.voices) { try { voice.source.stop(); } catch (_) {} voice.release(); }
    }

    dispose() {
      clearTimeout(this.suspendTimer); this.stopEffects();
      for (const node of this.persistentNodes) { try { node.stop?.(); node.disconnect(); } catch (_) {} }
      this.persistentNodes.length = 0;
      this.ctx?.close().catch(() => {});
      this.ctx = this.master = this.ambient = this.noiseBuffer = null;
    }
  }
  window.ForestAudio = ForestAudio;
})();
