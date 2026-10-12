// Turns free-form edit instructions (German or English, typos welcome) into a
// bounded set of planner preferences. Unknown text is simply ignored, and every
// recognised directive is reported back so the UI can show what was understood.

const DEFAULTS = Object.freeze({
  impactPosition: "near-end",
  impactSearchSeconds: null,
  beatSync: "balanced",
  detectDoubleTaps: true,
  removeMedalWatermark: false,
  watermarkScope: "medal",
  editingStyle: null,
  speedRamps: true,
  freezeFrames: true,
  transitions: true,
  effectIntensity: "normal",
  lyrics: true,
  impactWords: true
});

const LABELS = Object.freeze({
  "impact-at-end": "Kills at clip end",
  "impact-at-start": "Kills at clip start",
  "impact-at-center": "Kills centered",
  "impact-window": "Kill search window",
  "strict-beat-sync": "Exact beat sync",
  "loose-beat-sync": "Loose beat sync",
  "style-aggressive": "Aggressive style",
  "style-cinematic": "Cinematic style",
  "no-speed-ramps": "No slow-mo / ramps",
  "no-freeze": "No freeze frame",
  "no-transitions": "No transitions",
  "effects-high": "More effects",
  "effects-low": "Subtle effects",
  "no-lyrics": "No lyrics",
  "no-impact-words": "No impact words",
  "disable-double-tap": "D-tap detection off",
  "remove-medal-watermark": "Remove watermark",
  "watermark-all-clips": "Watermark: all clips"
});

const NEGATION = /(nicht|kein|keine|keinen|ohne|no|not|without|don'?t)\W*(\w+\W+){0,1}$/;

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss")
    .replace(/\s+/g, " ")
    .trim();
}

// True when the pattern occurs without a negation right in front of it.
function affirms(text, pattern) {
  const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(regex)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (!NEGATION.test(before)) return true;
  }
  return false;
}

function parseEditInstructions(value) {
  const raw = String(value || "").trim();
  const text = normalize(raw);
  const preferences = { ...DEFAULTS };
  const matched = [];
  if (!text) return { text: "", preferences, matched, labels: [] };
  const add = (id) => { if (!matched.includes(id)) matched.push(id); };

  const KILL = "(kills?|kils?|elims?|eliminations?|eliminierungen|treffer|impacts?|hits?|key ?moments?|highlights?|tode?)";
  const END = "(am ende|ans ende|zum ende|gegen ende|am schluss|at the end|end of|ending|endet|letzte[nr]? (sekunde|sec|teil))";
  if (new RegExp(`${KILL}.{0,45}${END}`).test(text)
      || /(jede[rsn]?|each|every|alle).{0,22}(clip|szene|video).{0,40}(kill|elimination|treffer).{0,22}(ende|end)/.test(text)
      || /(clips?|videos?).{0,30}(enden|end|hoeren auf).{0,20}(mit|with|nach|after).{0,15}(dem |the |einem |a )?(kill|elimination)/.test(text)) {
    preferences.impactPosition = "end";
    add("impact-at-end");
  } else if (new RegExp(`${KILL}.{0,35}(am anfang|zu beginn|am start|at the (start|beginning)|beginning)`).test(text)) {
    preferences.impactPosition = "start";
    add("impact-at-start");
  } else if (new RegExp(`${KILL}.{0,35}(mittig|in der mitte|center|middle)`).test(text)) {
    preferences.impactPosition = "center";
    add("impact-at-center");
  }
  const lastSeconds = text.match(/(letzte[nr]?|last|final)\s+(\d+(?:[.,]\d+)?)\s*(s\b|sek|sec|seconds?|sekunden)/);
  if (lastSeconds) {
    preferences.impactPosition = "end";
    preferences.impactSearchSeconds = Math.min(60, Math.max(0.5, Number(lastSeconds[2].replace(",", "."))));
    add("impact-at-end");
    add("impact-window");
  }

  if (/(streng|exakt|genau|strict|exact|perfekt|perfect|tight).{0,22}(beat|hit|takt|rhythm|sync|musik|music)/.test(text)
      || /(beat|hit|takt|sync).{0,22}(streng|exakt|genau|strict|exact|perfekt|perfect)/.test(text)) {
    preferences.beatSync = "strict";
    add("strict-beat-sync");
  } else if (/(locker|loose|relaxed|nicht so streng|less strict)/.test(text)) {
    preferences.beatSync = "balanced";
    add("loose-beat-sync");
  }

  if (affirms(text, /(aggressiv|aggressive|schnell|fast cuts|hart|hard|krass|brutal|intens|hype)/)) {
    preferences.editingStyle = "aggressive";
    add("style-aggressive");
  } else if (affirms(text, /(cinematic|kinematisch|ruhig|smooth|langsam|chill|calm)/)) {
    preferences.editingStyle = "cinematic";
    add("style-cinematic");
  }

  if (/(kein|keine|ohne|no|without|disable).{0,14}(slow ?mo|slow ?motion|zeitlupe|speed ?ramps?|velocity|ramps?)/.test(text)) {
    preferences.speedRamps = false;
    add("no-speed-ramps");
  }
  if (/(kein|keine|ohne|no|without).{0,10}(freeze|standbild|einfrieren)/.test(text)) {
    preferences.freezeFrames = false;
    add("no-freeze");
  }
  if (/(kein|keine|ohne|no|without).{0,10}(uebergaenge?|transitions?|whips?)/.test(text)) {
    preferences.transitions = false;
    add("no-transitions");
  }
  if (/(mehr|viele|viel|more|lots of|krasse|heftige|starke).{0,10}(effekte?|effects?|fx)/.test(text)) {
    preferences.effectIntensity = "high";
    add("effects-high");
  } else if (/(wenig|weniger|dezente?|subtile?|less|fewer|subtle|minimal)\s?(effekte?|effects?|fx)/.test(text)
      || /(effekte?|effects?|fx).{0,12}(dezent|subtil|subtle)/.test(text)) {
    preferences.effectIntensity = "low";
    add("effects-low");
  }

  if (/(kein|keine|ohne|no|without).{0,10}(lyrics?|songtext|untertitel|subtitles?|captions?)/.test(text)) {
    preferences.lyrics = false;
    add("no-lyrics");
  }
  if (/(kein|keine|ohne|no|without).{0,10}(impact.?)?(woerter|words?|keywords?|schlagwoerter)/.test(text)) {
    preferences.impactWords = false;
    add("no-impact-words");
  }

  if (/(kein|ohne|disable|no).{0,18}(d[- ]?tap|double.{0,8}(crystal|tap))/.test(text)) {
    preferences.detectDoubleTaps = false;
    add("disable-double-tap");
  }
  if (/(wasserzeichen|watermark|wm\b|logo|medal.?(logo|zeichen)).{0,28}(entfern|weg|crop|remove|raus|loeschen)/.test(text)
      || /(entfern|weg|crop|remove|raus).{0,24}(wasserzeichen|watermark|logo)/.test(text)) {
    preferences.removeMedalWatermark = true;
    add("remove-medal-watermark");
    const sentence = text.split(/[.!?;\n]/).find((part) => /(wasserzeichen|watermark|logo)/.test(part)) || "";
    if (/(alle[nr]?|all|jede[mn]?|every).{0,12}(clips?|videos?)/.test(sentence)) {
      preferences.watermarkScope = "all";
      add("watermark-all-clips");
    }
  }
  return { text: raw, preferences, matched, labels: matched.map((id) => LABELS[id] || id) };
}

module.exports = { DEFAULTS, LABELS, parseEditInstructions };
